/**
 * Seccion V del arnes del main (scripts/check-main.js): varios espectadores
 * por sesion (window-registry.js: join/leave, conductor del tamano). Ventanas
 * falsas: una duena y uno o dos espectadores.
 *
 *  V1  la salida de la sesion llega a la duena y a cada espectador.
 *  V2  input y resize de un espectador pasan mayUse; un tercero ajeno, no.
 *  V3  join a mitad de la salida (10 000 trozos, la duena contesta tarde
 *      mientras siguen llegando): pantalla + bufer = lo emitido, sin perder
 *      ni repetir. Con el windowMove.js de verdad (esbuild) contestando.
 *  V4  la duena no contesta: a tiempo llega join-screen history:false y el
 *      bufer, nunca se queda colgado.
 *  V5  conductor: solo su resize llega al pty; teclear cambia de conductor y
 *      aplica su tamano; las respuestas automaticas de xterm no cuentan.
 *  V6  session:size llega a todos cuando cambia el tamano del pty.
 *  V7  el primer resize de un espectador abre la shell diferida (waitSize)
 *      aunque la ventana duena nunca mande el suyo.
 *  V8  cerrar la ventana de un espectador no cierra la sesion; cerrar la
 *      duena con espectadores tampoco: el espectador pasa a ser el dueno.
 *  V9  un espectador destruido se ignora (ni send ni excepcion).
 *  V10 sin espectadores, todo como antes: cada resize pasa, nada de session:size.
 *
 * Espejo web (F3): el navegador es una ventana VIRTUAL (ipc.attachWebClient).
 *  V11 nunca es duena: claim lo ignora; si la duena se va y solo queda el
 *      virtual, la sesion termina como siempre (Background); con otra ventana
 *      del PC espectadora, pasa a esa aunque el virtual sea mas antiguo. Ni
 *      primaria, ni numero, ni en list(), ni destino ni origen de mudanza.
 *  V15 el navegador conductor se va: la duena recibe session:size release
 *      (suelta follow) y el pty vuelve a su tamano; igual si quedan otros
 *      espectadores (ellos reciben el session:size normal, no el release).
 *  V12 un disconnect limpia: deja de ser espectador de todo, el conductor
 *      vuelve a la duena (su tamano al pty), sale del registro y de la lista.
 *  V13 mirror:command llega al renderer del PC (limpio) y mirror:state vuelve
 *      al navegador con el sessionId vivo; ordenes malas o desde el PC, no.
 *  V14 web:clients / web:kick: solo el PC; aviso al PC al conectar.
 *  V16 conductor por interaccion: session:conduct (clic o foco en el panel)
 *      lo cambia sin teclear y aplica su tamano; las respuestas automaticas
 *      de xterm no; sin espectadores no hace nada; un tercero ajeno, nada.
 */
const assert = require('assert');
const path = require('path');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Una ventana falsa. `alRecibir(canal, args)`: el "renderer", en orden. */
/* Un navegador del espejo: lo que gateway.js le pone al webContents virtual */
let idVirtual = 1000000;
function navegadorFalso(nombre, login = 'owner@example.com') {
  const recibido = [];
  let vivo = true;
  const wc = {
    nombre, id: ++idVirtual, isWeb: true, login, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130', connectedAt: Date.now(),
    send: (canal, ...args) => { if (!vivo) throw new Error(`send a ${nombre} destruido`); recibido.push([canal, ...args]); },
    isDestroyed: () => !vivo,
    desconectados: 0,
    disconnect: () => { wc.desconectados++; },
    morir: () => { vivo = false; },
  };
  return { wc, recibido, de: (canal) => recibido.filter(([c]) => c === canal) };
}

function ventanaFalsa(nombre, { alRecibir } = {}) {
  const recibido = [];
  const oyentes = new Map();
  let vivo = true;
  const wc = {
    nombre,
    send: (canal, ...args) => {
      if (!vivo) throw new Error(`send a ${nombre} destruida`);
      recibido.push([canal, ...args]);
      if (alRecibir) alRecibir(canal, args);
    },
    isDestroyed: () => !vivo,
  };
  const win = {
    webContents: wc,
    isDestroyed: () => !vivo,
    isFocused: () => false,
    getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    on: (ev, fn) => { if (!oyentes.has(ev)) oyentes.set(ev, []); oyentes.get(ev).push(fn); return win; },
    once: (ev, fn) => win.on(ev, fn),
    cerrar: () => { vivo = false; for (const fn of oyentes.get('closed') || []) fn(); },
    destruir: () => { vivo = false; },
    flashFrame: () => {},
  };
  return { win, wc, recibido, de: (canal) => recibido.filter(([c]) => c === canal) };
}

/* Lo que una ventana ve de la sesion: la pantalla del join y luego los datos */
function vista(V, sid) {
  let out = '';
  for (const [c, ...a] of V.recibido) {
    if (c === 'session:join-screen' && a[0].sessionId === sid) out += a[0].data;
    if (c === 'ssh:data' && a[0] === sid) out += a[1];
  }
  return out;
}

function cargaWindowMove(ROOT) {
  const esbuild = require('esbuild');
  const out = esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'src', 'components', 'SplitPane', 'windowMove.js')],
    bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  });
  const Module = require('module');
  const m = new Module('windowMove-arnes-v');
  m._compile(out.outputFiles[0].text, 'windowMove-arnes-v.js');
  return m.exports;
}

async function seccionEspectadores({ check, ROOT, handlers, onHandlers }) {
  const E = (...p) => require(path.join(ROOT, 'electron', ...p));
  const registry = E('window-registry.js');
  const ipc = E('ipc-handlers.js');
  const sshService = E('services', 'ssh-service.js');
  const localShellService = E('services', 'local-shell-service.js');

  const nuevas = (...nombres) => nombres.map((n) => {
    const V = ventanaFalsa(n);
    ipc.attachWindow(V.win);
    return V;
  });
  const unir = async (V, sid) => {
    const r = await handlers.get('session:join')({ sender: V.wc }, sid);
    assert.ok(r.success, `session:join fallo: ${r.error}`);
    return r.data.joinId;
  };
  const contestar = async (V, joinId, snap) => {
    const r = await handlers.get('session:snapshot')({ sender: V.wc }, joinId, snap);
    assert.ok(r.success, `session:snapshot fallo: ${r.error}`);
    return r.data;
  };

  /* Los servicios, de mentira mientras dura la seccion: se apunta lo que llega */
  const pty = [];
  const real = {
    sendData: sshService.sendData, sresize: sshService.resize,
    write: localShellService.write, lresize: localShellService.resize,
    isConnected: sshService.isConnected, disconnect: sshService.disconnect,
  };
  sshService.sendData = (sid, d) => pty.push(['ssh:data', sid, d]);
  sshService.resize = (sid, c, r) => pty.push(['ssh:resize', sid, c, r]);
  localShellService.write = (sid, d) => pty.push(['local:write', sid, d]);
  localShellService.resize = (sid, c, r) => pty.push(['local:resize', sid, c, r]);
  const timeoutAntes = registry.joinTimeoutMs;

  try {
    await check('V1 la salida de una sesion llega a la duena y a cada espectador', async () => {
      const [A, B, C] = nuevas('A-v1', 'B-v1', 'C-v1');
      const sid = 'v1-sid';
      registry.claim(sid, A.wc);
      const jb = await unir(B, sid);
      const jc = await unir(C, sid);
      assert.strictEqual(A.de('session:snapshot-request').length, 2, 'la duena no recibio las dos peticiones');
      assert.ok(await contestar(A, jb, { data: 'pantalla', cols: 80, rows: 24 }));
      assert.ok(await contestar(A, jc, { data: 'pantalla', cols: 80, rows: 24 }));
      registry.sessionSink.webContents.send('ssh:data', sid, 'hola-todos');
      for (const V of [A, B, C]) {
        assert.ok(V.de('ssh:data').some(([, s, d]) => s === sid && d === 'hola-todos'), `${V.wc.nombre} no recibio la salida`);
      }
      assert.strictEqual(vista(B, sid), 'pantallahola-todos');
      registry.release(sid);
      for (const V of [A, B, C]) V.win.cerrar();
    });

    await check('V2 input y resize de un espectador pasan mayUse; un tercero ajeno, rechazado', async () => {
      const [A, B, D] = nuevas('A-v2', 'B-v2', 'D-v2');
      const sid = 'v2-sid';
      registry.claim(sid, A.wc);
      registry.noteSize(sid, 80, 24);
      await unir(B, sid);
      pty.length = 0;
      assert.ok(registry.mayUse(sid, B.wc), 'mayUse rechazo al espectador');
      assert.ok(!registry.mayUse(sid, D.wc), 'mayUse acepto a un tercero');
      onHandlers.get('ssh:send-data')({ sender: B.wc }, sid, 'ls\r');
      onHandlers.get('ssh:resize')({ sender: B.wc }, sid, 90, 30);
      onHandlers.get('ssh:send-data')({ sender: D.wc }, sid, 'intruso\r');
      onHandlers.get('ssh:resize')({ sender: D.wc }, sid, 10, 5);
      const r = await handlers.get('session:snapshot')({ sender: D.wc }, 'nada', { data: 'x' });
      assert.ok(r.success && r.data === false, 'un tercero contesto un join');
      assert.deepStrictEqual(pty, [['ssh:data', sid, 'ls\r'], ['ssh:resize', sid, 90, 30]],
        `al pty llego otra cosa: ${JSON.stringify(pty)}`);
      /* local:* igual */
      const lsid = 'v2-pty';
      registry.claim(lsid, A.wc);
      registry.noteSize(lsid, 80, 24);
      await unir(B, lsid);
      pty.length = 0;
      onHandlers.get('local:write')({ sender: B.wc }, lsid, 'x');
      onHandlers.get('local:write')({ sender: D.wc }, lsid, 'y');
      onHandlers.get('local:resize')({ sender: B.wc }, lsid, 70, 20);
      assert.deepStrictEqual(pty, [['local:write', lsid, 'x'], ['local:resize', lsid, 70, 20]]);
      registry.release(sid);
      registry.release(lsid);
      for (const V of [A, B, D]) V.win.cerrar();
    });

    await check('V3 join a mitad de la salida: pantalla -> bufer en orden, sin perder ni repetir (windowMove.js real)', async () => {
      /* El renderer de la duena: un "xterm" que acumula lo que le llega y el
         modulo windowMove de verdad contestando la peticion de pantalla */
      let pantalla = '';
      let alRequest = null;
      const A = ventanaFalsa('A-v3', {
        alRecibir: (canal, args) => {
          if (canal === 'ssh:data') pantalla += args[1];
          if (canal === 'session:snapshot-request' && alRequest) alRequest(args[0]);
        },
      });
      const [B, C] = nuevas('B-v3', 'C-v3');
      ipc.attachWindow(A.win);
      const sid = 'v3-sid';
      registry.claim(sid, A.wc);
      const respuestas = [];
      const antes = global.window;
      global.window = {
        electronAPI: {
          session: {
            onSnapshotRequest: (cb) => { alRequest = cb; return cb; },
            snapshot: (joinId, snap) => {
              /* La respuesta vuelve tarde: siguen saliendo trozos mientras tanto */
              const p = new Promise((res) => setTimeout(res, 15)).then(() => contestar(A, joinId, snap));
              respuestas.push(p);
              return p;
            },
          },
        },
      };
      try {
        const wm = cargaWindowMove(ROOT);
        /* snapshotAt: la pantalla tal como esta en el punto de la peticion
           (en TerminalView, el callback de term.write('') ) */
        const quitar = wm.registerTerminal('tab-v3', {
          sessionId: () => sid,
          snapshotAt: () => Promise.resolve({ data: pantalla, cols: 80, rows: 24, connected: true }),
        });
        let emitido = '';
        const emite = (i) => {
          const d = `${i}é中\r\n`;   // UTF-8 ya decodificado: strings, no bytes
          emitido += d;
          registry.sessionSink.webContents.send('ssh:data', sid, d);
        };
        let i = 0;
        for (; i < 4000; i++) emite(i);
        await unir(B, sid);
        for (; i < 7000; i++) {
          emite(i);
          if (i % 500 === 0) await sleep(1);   // la respuesta llega entre trozos
        }
        await unir(C, sid);
        for (; i < 10000; i++) emite(i);
        await Promise.all(respuestas);
        await sleep(5);
        for (; i < 10100; i++) emite(i);
        quitar();
        assert.strictEqual(respuestas.length, 2, 'windowMove no contesto las dos peticiones');
        for (const V of [B, C]) {
          const js = V.de('session:join-screen');
          assert.strictEqual(js.length, 1);
          assert.strictEqual(js[0][1].history, true, `${V.wc.nombre}: sin historial`);
          const pos = V.recibido.findIndex(([c]) => c === 'session:join-screen');
          assert.ok(!V.recibido.slice(0, pos).some(([c]) => c === 'ssh:data'), `${V.wc.nombre}: datos antes de la pantalla`);
          const v = vista(V, sid);
          assert.strictEqual(v.length, emitido.length, `${V.wc.nombre}: ${v.length} caracteres, se emitieron ${emitido.length}`);
          assert.ok(v === emitido, `${V.wc.nombre}: la vista no es lo emitido (perdida o duplicado)`);
        }
        assert.strictEqual(pantalla, emitido, 'la duena perdio algo');
      } finally {
        global.window = antes;
      }
      registry.release(sid);
      for (const V of [A, B, C]) V.win.cerrar();
    });

    await check('V4 la duena no contesta: join-screen history:false y el bufer, a tiempo', async () => {
      registry.joinTimeoutMs = 60;
      const [A, B] = nuevas('A-v4', 'B-v4');
      const sid = 'v4-sid';
      registry.claim(sid, A.wc);
      registry.sessionSink.webContents.send('ssh:data', sid, 'antes|');
      const jb = await unir(B, sid);
      registry.sessionSink.webContents.send('ssh:data', sid, 'durante|');
      assert.strictEqual(B.recibido.length, 0, 'el espectador recibio algo antes de su pantalla');
      await sleep(120);
      const js = B.de('session:join-screen');
      assert.strictEqual(js.length, 1, 'sin join-screen tras el timeout');
      assert.strictEqual(js[0][1].history, false);
      assert.strictEqual(js[0][1].reason, 'timeout');
      registry.sessionSink.webContents.send('ssh:data', sid, 'despues');
      assert.strictEqual(vista(B, sid), 'durante|despues');
      /* Una respuesta tardia ya no cambia nada */
      assert.strictEqual(await contestar(A, jb, { data: 'tarde' }), false);
      assert.strictEqual(B.de('session:join-screen').length, 1);
      registry.joinTimeoutMs = timeoutAntes;
      registry.release(sid);
      for (const V of [A, B]) V.win.cerrar();
    });

    await check('V5+V6 conductor: solo su resize llega al pty; teclear lo cambia; session:size a todos', async () => {
      const [A, B, C] = nuevas('A-v5', 'B-v5', 'C-v5');
      const sid = 'v5-sid';
      registry.claim(sid, A.wc);
      onHandlers.get('ssh:resize')({ sender: A.wc }, sid, 100, 30);
      await contestar(A, await unir(B, sid), { data: '' });
      await contestar(A, await unir(C, sid), { data: '' });
      pty.length = 0;
      const tam = (V) => V.de('session:size').map(([, p]) => `${p.cols}x${p.rows}`);
      /* Nadie tecleo: conduce la duena */
      onHandlers.get('ssh:resize')({ sender: B.wc }, sid, 80, 24);
      assert.deepStrictEqual(pty, [], 'el resize de un no conductor llego al pty');
      onHandlers.get('ssh:resize')({ sender: A.wc }, sid, 110, 35);
      assert.deepStrictEqual(pty, [['ssh:resize', sid, 110, 35]]);
      for (const V of [A, B, C]) assert.deepStrictEqual(tam(V), ['110x35'], `${V.wc.nombre}: session:size`);
      /* Una respuesta automatica de xterm (DA, foco) desde B no lo hace conductor */
      pty.length = 0;
      onHandlers.get('ssh:send-data')({ sender: B.wc }, sid, '\x1b[?1;2c');
      onHandlers.get('ssh:send-data')({ sender: B.wc }, sid, '\x1b[I');
      assert.deepStrictEqual(pty.filter(([c]) => c === 'ssh:resize'), [], 'una respuesta automatica cambio de conductor');
      assert.strictEqual(registry.conductorOf(sid), A.wc);
      /* B teclea: conduce B; su tamano (80x24) llega al pty ANTES que la tecla */
      pty.length = 0;
      onHandlers.get('ssh:send-data')({ sender: B.wc }, sid, 'a');
      assert.deepStrictEqual(pty, [['ssh:resize', sid, 80, 24], ['ssh:data', sid, 'a']]);
      assert.strictEqual(registry.conductorOf(sid), B.wc);
      for (const V of [A, B, C]) assert.deepStrictEqual(tam(V), ['110x35', '80x24'], `${V.wc.nombre}: session:size tras cambiar de conductor`);
      /* Ahora el de A se ignora y el de B pasa */
      pty.length = 0;
      onHandlers.get('ssh:resize')({ sender: A.wc }, sid, 120, 40);
      onHandlers.get('ssh:resize')({ sender: B.wc }, sid, 81, 25);
      assert.deepStrictEqual(pty, [['ssh:resize', sid, 81, 25]]);
      /* A vuelve a teclear: el pty vuelve a su ultimo tamano */
      pty.length = 0;
      onHandlers.get('ssh:send-data')({ sender: A.wc }, sid, 'b');
      assert.deepStrictEqual(pty, [['ssh:resize', sid, 120, 40], ['ssh:data', sid, 'b']]);
      /* El conductor se va: conduce la duena (ya lo era) */
      onHandlers.get('ssh:send-data')({ sender: C.wc }, sid, 'c');
      assert.strictEqual(registry.conductorOf(sid), C.wc);
      registry.leave(sid, C.wc);
      assert.strictEqual(registry.conductorOf(sid), A.wc);
      registry.release(sid);
      for (const V of [A, B, C]) V.win.cerrar();
    });

    await check('V16 conductor por interaccion: un clic o foco (session:conduct) lo cambia, no solo una tecla; las respuestas automaticas no', async () => {
      const [A, B, D] = nuevas('A-v16', 'B-v16', 'D-v16');
      const sid = 'v16-sid';
      registry.claim(sid, A.wc);
      onHandlers.get('ssh:resize')({ sender: A.wc }, sid, 160, 40);
      /* Sin espectadores no hace nada (escritorio con la web apagada) */
      pty.length = 0;
      onHandlers.get('session:conduct')({ sender: A.wc }, sid);
      assert.deepStrictEqual(pty, [], 'session:conduct sin espectadores toco el pty');
      assert.strictEqual(A.de('session:conductor').length, 0, 'session:conductor sin espectadores');
      await contestar(A, await unir(B, sid), { data: '' });
      /* El navegador mide su panel: se recuerda, no llega al pty */
      pty.length = 0;
      onHandlers.get('ssh:resize')({ sender: B.wc }, sid, 100, 30);
      assert.deepStrictEqual(pty, [], 'el resize de un no conductor llego al pty');
      /* Respuestas automaticas de xterm (foco, posicion del cursor, DA): no cuentan */
      for (const auto of ['\x1b[I', '\x1b[O', '\x1b[12;40R', '\x1b[?1;2c', '\x1b]11;rgb:0000/0000/0000\x07']) {
        onHandlers.get('ssh:send-data')({ sender: B.wc }, sid, auto);
      }
      assert.deepStrictEqual(pty.filter(([c]) => c === 'ssh:resize'), [], 'una respuesta automatica cambio el tamano');
      assert.strictEqual(registry.conductorOf(sid), A.wc, 'una respuesta automatica cambio de conductor');
      /* Un clic / foco en el panel del navegador, sin teclear: conduce B y el pty toma su tamano */
      pty.length = 0;
      onHandlers.get('session:conduct')({ sender: B.wc }, sid);
      assert.deepStrictEqual(pty, [['ssh:resize', sid, 100, 30]], `al pty llego: ${JSON.stringify(pty)}`);
      assert.strictEqual(registry.conductorOf(sid), B.wc);
      assert.deepStrictEqual(A.de('session:conductor').pop()[1], { sessionId: sid, conducting: false });
      assert.deepStrictEqual(B.de('session:conductor').pop()[1], { sessionId: sid, conducting: true });
      assert.ok(A.de('session:size').some(([, p]) => p.cols === 100 && p.rows === 30), 'la duena no supo del nuevo tamano');
      /* Repetirlo no hace nada; un tercero ajeno no puede */
      pty.length = 0;
      onHandlers.get('session:conduct')({ sender: B.wc }, sid);
      onHandlers.get('session:conduct')({ sender: D.wc }, sid);
      onHandlers.get('session:conduct')({ sender: B.wc }, 42);
      assert.deepStrictEqual(pty, []);
      assert.strictEqual(registry.conductorOf(sid), B.wc, 'un tercero se hizo conductor');
      /* De vuelta al PC: un clic alli y recupera el conductor con su tamano */
      onHandlers.get('session:conduct')({ sender: A.wc }, sid);
      assert.deepStrictEqual(pty, [['ssh:resize', sid, 160, 40]]);
      assert.strictEqual(registry.conductorOf(sid), A.wc);
      /* local:* igual */
      const lsid = 'v16-pty';
      registry.claim(lsid, A.wc);
      onHandlers.get('local:resize')({ sender: A.wc }, lsid, 150, 45);
      await contestar(A, await unir(B, lsid), { data: '' });
      onHandlers.get('local:resize')({ sender: B.wc }, lsid, 90, 28);
      pty.length = 0;
      onHandlers.get('session:conduct')({ sender: B.wc }, lsid);
      assert.deepStrictEqual(pty, [['local:resize', lsid, 90, 28]]);
      registry.release(sid);
      registry.release(lsid);
      for (const V of [A, B, D]) V.win.cerrar();
    });

    await check('V7 el primer resize real de un espectador abre la shell diferida (waitSize) con la duena oculta', async () => {
      sshService.resize = real.sresize;
      const [A, B] = nuevas('A-v7', 'B-v7');
      const sid = 'v7-sid';
      const abiertas = [];
      /* Una sesion SSH de verdad del servicio, a medio abrir: la shell espera su primer tamano */
      sshService.sessions.set(sid, { openDeferred: (c, r) => abiertas.push([c, r]), cols: 80, rows: 24 });
      try {
        registry.claim(sid, A.wc);
        await unir(B, sid);   // la duena oculta: ni contesta ni manda tamano
        onHandlers.get('ssh:resize')({ sender: B.wc }, sid, 0, 0);
        assert.deepStrictEqual(abiertas, [], 'un 0x0 de un espectador abrio la shell');
        onHandlers.get('ssh:resize')({ sender: B.wc }, sid, 132, 43);
        assert.deepStrictEqual(abiertas, [[132, 43]], `la shell diferida no se abrio al tamano del espectador: ${JSON.stringify(abiertas)}`);
        assert.ok(sshService.sessions.get(sid).sized, 'la sesion no quedo sized');
        assert.deepStrictEqual(registry.ptySizeOf(sid), { cols: 132, rows: 43 });
      } finally {
        sshService.sessions.delete(sid);
        sshService.resize = (s, c, r) => pty.push(['ssh:resize', s, c, r]);
        registry.release(sid);
        for (const V of [A, B]) V.win.cerrar();
      }
    });

    await check('V8 cerrar un espectador no cierra la sesion; cerrar la duena con espectadores, tampoco', async () => {
      const [A, B, C] = nuevas('A-v8', 'B-v8', 'C-v8');
      const sid = 'v8-sid';
      const cerradas = [];
      sshService.isConnected = (s) => s === sid || real.isConnected.call(sshService, s);
      sshService.disconnect = async (s) => { if (s === sid) cerradas.push(s); else return real.disconnect.call(sshService, s); };
      try {
        registry.claim(sid, A.wc);
        await contestar(A, await unir(B, sid), { data: '' });
        await contestar(A, await unir(C, sid), { data: '' });
        B.win.cerrar();
        await sleep(10);
        assert.deepStrictEqual(cerradas, [], 'cerrar un espectador termino la sesion');
        assert.strictEqual(registry.ownerOf(sid), A.wc);
        assert.ok(!registry.isViewer(sid, B.wc));
        registry.sessionSink.webContents.send('ssh:data', sid, 'sigue');
        assert.ok(A.de('ssh:data').some(([, , d]) => d === 'sigue') && C.de('ssh:data').some(([, , d]) => d === 'sigue'));
        /* La duena se va: C pasa a duena, la sesion sigue */
        A.win.cerrar();
        await sleep(10);
        assert.deepStrictEqual(cerradas, [], 'cerrar la duena con espectadores termino la sesion');
        assert.strictEqual(registry.ownerOf(sid), C.wc, 'el espectador no paso a ser el dueno');
        assert.ok(registry.mayUse(sid, C.wc));
        registry.sessionSink.webContents.send('ssh:data', sid, 'con-C');
        assert.ok(C.de('ssh:data').some(([, , d]) => d === 'con-C'));
        /* Y sin nadie mas, cerrar la ultima termina la sesion como siempre */
        C.win.cerrar();
        await sleep(10);
        assert.deepStrictEqual(cerradas, [sid], 'cerrar la ultima ventana no termino la sesion');
      } finally {
        sshService.isConnected = real.isConnected;
        sshService.disconnect = real.disconnect;
        registry.release(sid);
      }
    });

    await check('V9 un espectador destruido se ignora (sin send, sin excepcion)', async () => {
      const [A, B, C] = nuevas('A-v9', 'B-v9', 'C-v9');
      const sid = 'v9-sid';
      registry.claim(sid, A.wc);
      registry.noteSize(sid, 80, 24);
      await contestar(A, await unir(B, sid), { data: '' });
      await contestar(A, await unir(C, sid), { data: '' });
      B.win.destruir();   // destruido pero sin 'closed' todavia
      const n = B.recibido.length;
      registry.sessionSink.webContents.send('ssh:data', sid, 'x');
      onHandlers.get('ssh:send-data')({ sender: C.wc }, sid, 'k');   // cambia de conductor: session:size no va a B
      assert.strictEqual(B.recibido.length, n, 'se mando algo a un webContents destruido');
      assert.ok(C.de('ssh:data').some(([, , d]) => d === 'x'));
      assert.throws(() => registry.join(sid, B.wc), /Unknown window/);
      /* Su resize tampoco conduce */
      onHandlers.get('ssh:send-data')({ sender: B.wc }, sid, 'z');
      assert.notStrictEqual(registry.conductorOf(sid), B.wc, 'un destruido es el conductor');
      registry.release(sid);
      for (const V of [A, B, C]) V.win.cerrar();
    });

    await check('V10 sin espectadores, como antes: cada resize pasa y no hay session:size', async () => {
      const [A, B] = nuevas('A-v10', 'B-v10');
      const sid = 'v10-sid';
      registry.claim(sid, A.wc);
      pty.length = 0;
      onHandlers.get('ssh:resize')({ sender: A.wc }, sid, 80, 24);
      onHandlers.get('ssh:resize')({ sender: A.wc }, sid, 0, 0);
      onHandlers.get('ssh:resize')({ sender: A.wc }, sid, 90, 30);
      onHandlers.get('ssh:send-data')({ sender: A.wc }, sid, 'q');
      assert.deepStrictEqual(pty, [['ssh:resize', sid, 80, 24], ['ssh:resize', sid, 0, 0], ['ssh:resize', sid, 90, 30], ['ssh:data', sid, 'q']]);
      assert.strictEqual(A.de('session:size').length, 0, 'session:size sin espectadores');
      /* Un espectador que se va deja la sesion como estaba */
      await contestar(A, await unir(B, sid), { data: '' });
      assert.ok(registry.leave(sid, B.wc));
      pty.length = 0;
      onHandlers.get('ssh:resize')({ sender: A.wc }, sid, 91, 31);
      assert.deepStrictEqual(pty, [['ssh:resize', sid, 91, 31]]);
      registry.release(sid);
      for (const V of [A, B]) V.win.cerrar();
    });

    await check('V11 el navegador nunca es dueno: ni por claim, ni heredando; fuera de list/primaria/mudanzas', async () => {
      const [A, P] = nuevas('A-v11', 'P-v11');
      const W = navegadorFalso('W-v11');
      ipc.attachWebClient(W.wc);
      const sid = 'v11-sid';
      const sb = 'v11-b';
      const cerradas = [];
      sshService.isConnected = (s) => s === sid || s === sb || real.isConnected.call(sshService, s);
      sshService.disconnect = async (s) => { if (s === sid || s === sb) cerradas.push(s); else return real.disconnect.call(sshService, s); };
      let Q = null;
      try {
        registry.claim('v11-propia', W.wc);
        assert.strictEqual(registry.ownerOf('v11-propia'), null, 'el navegador quedo como dueno por claim');
        const e = registry.entryOf(W.wc);
        assert.ok(e && e.virtual && e.number === 0, 'la ventana virtual tomo un numero de ventana');
        assert.ok(!registry.list(A.wc).some(x => x.id === W.wc.id), 'el navegador aparece en "Mover a ventana"');
        assert.ok(registry.primary() && !registry.primary().virtual, 'el navegador es la ventana primaria');
        assert.notStrictEqual(registry.focused().wc, W.wc);
        assert.strictEqual(registry.agentRows(W.wc).windows, registry.pcWindows().length, 'el navegador cuenta como ventana del PC');
        assert.ok(!registry.pcWindows().some(x => x.wc === W.wc));
        assert.strictEqual(registry.byId(W.wc.id), null);
        registry.claim(sid, A.wc);
        /* El navegador se une primero (mas antiguo), luego otra ventana del PC */
        await contestar(A, await unir({ wc: W.wc }, sid), { data: 'x' });
        await contestar(A, await unir(P, sid), { data: 'x' });
        assert.throws(() => registry.beginMove([], W.wc), /browser/);
        const mv = registry.beginMove([sid], A.wc);
        assert.throws(() => registry.setTarget(mv, W.wc, {}), /browser/, 'una mudanza pudo ir al navegador');
        registry.abort(mv, 'test');
        A.win.cerrar();
        await sleep(10);
        assert.strictEqual(registry.ownerOf(sid), P.wc, 'la sesion no paso a la otra ventana del PC');
        assert.ok(registry.isViewer(sid, W.wc), 'el navegador dejo de ver la sesion');
        assert.deepStrictEqual(cerradas, []);
        /* Solo queda el navegador como espectador: la duena se va -> termina, nunca al navegador */
        registry.claim(sb, P.wc);
        await contestar(P, await unir({ wc: W.wc }, sb), { data: '' });
        [Q] = nuevas('Q-v11');
        P.win.cerrar();
        await sleep(10);
        assert.notStrictEqual(registry.ownerOf(sb), W.wc, 'el navegador heredo la sesion');
        assert.ok(cerradas.includes(sb), 'la sesion sin duena del PC no termino (Background) como siempre');
      } finally {
        sshService.isConnected = real.isConnected;
        sshService.disconnect = real.disconnect;
        ipc.detachWebClient(W.wc);
        if (Q) Q.win.cerrar();
        for (const s of [sid, sb]) registry.release(s);
      }
    });

    await check('V12 disconnect del navegador: deja todo, el conductor vuelve a la duena, fuera del registro', async () => {
      const [A] = nuevas('A-v12');
      const W = navegadorFalso('W-v12');
      ipc.attachWebClient(W.wc);
      const s1 = 'v12-a'; const s2 = 'v12-b';
      for (const s of [s1, s2]) {
        registry.claim(s, A.wc);
        await contestar(A, await unir({ wc: W.wc }, s), { data: '' });
      }
      pty.length = 0;
      onHandlers.get('ssh:resize')({ sender: A.wc }, s1, 100, 30);
      onHandlers.get('ssh:resize')({ sender: W.wc }, s1, 60, 20);
      onHandlers.get('ssh:send-data')({ sender: W.wc }, s1, 'ls\r');
      assert.strictEqual(registry.conductorOf(s1), W.wc);
      assert.deepStrictEqual(registry.ptySizeOf(s1), { cols: 60, rows: 20 });
      W.wc.morir();
      ipc.detachWebClient(W.wc);
      assert.ok(!registry.isViewer(s1, W.wc) && !registry.isViewer(s2, W.wc), 'sigue de espectador');
      assert.strictEqual(registry.entryOf(W.wc), null, 'sigue en el registro');
      assert.strictEqual(registry.conductorOf(s1), A.wc);
      assert.deepStrictEqual(registry.ptySizeOf(s1), { cols: 100, rows: 30 }, 'el pty no volvio al tamano de la duena');
      assert.strictEqual(registry.ownerOf(s1), A.wc, 'la sesion perdio su duena');
      const clients = await handlers.get('web:clients')({ sender: A.wc });
      assert.ok(clients.success && !clients.data.some(c => c.id === W.wc.id), 'sigue en web:clients');
      for (const s of [s1, s2]) registry.release(s);
      A.win.cerrar();
    });

    await check('V15 se va el navegador conductor: la duena recibe release y el pty vuelve a su tamano (solo, y con otro espectador)', async () => {
      const [A] = nuevas('A-v15');
      const W = navegadorFalso('W-v15');
      const W2 = navegadorFalso('W2-v15');
      ipc.attachWebClient(W.wc);
      ipc.attachWebClient(W2.wc);
      const releases = (V) => V.de('session:size').filter(([, p]) => p.release).map(([, p]) => p);
      /* Solo el navegador: se va con session:leave */
      const s1 = 'v15-solo';
      registry.claim(s1, A.wc);
      onHandlers.get('ssh:resize')({ sender: A.wc }, s1, 200, 50);
      await contestar(A, await unir({ wc: W.wc }, s1), { data: '' });
      onHandlers.get('ssh:resize')({ sender: W.wc }, s1, 80, 24);
      onHandlers.get('ssh:send-data')({ sender: W.wc }, s1, 'x');
      assert.deepStrictEqual(registry.ptySizeOf(s1), { cols: 80, rows: 24 });
      assert.ok(A.de('session:size').some(([, p]) => p.sessionId === s1 && p.cols === 80 && !p.release), 'la duena no supo del 80x24');
      assert.deepStrictEqual(releases(A), []);
      pty.length = 0;
      const r = await handlers.get('session:leave')({ sender: W.wc }, s1);
      assert.ok(r.success, r.error);
      assert.deepStrictEqual(releases(A), [{ sessionId: s1, cols: 200, rows: 50, release: true }], 'la duena no recibio el aviso');
      assert.deepStrictEqual(registry.ptySizeOf(s1), { cols: 200, rows: 50 });
      assert.deepStrictEqual(pty, [['ssh:resize', s1, 200, 50]]);
      assert.ok(!W.de('session:size').some(([, p]) => p.release), 'el release llego al navegador');
      /* Despues, sin espectadores, como siempre: cada resize pasa */
      pty.length = 0;
      onHandlers.get('ssh:resize')({ sender: A.wc }, s1, 190, 45);
      assert.deepStrictEqual(pty, [['ssh:resize', s1, 190, 45]]);

      /* Con dos navegadores: conduce W, W se va (desconexion), queda W2 */
      const s2 = 'v15-dos';
      registry.claim(s2, A.wc);
      onHandlers.get('ssh:resize')({ sender: A.wc }, s2, 200, 50);
      await contestar(A, await unir({ wc: W.wc }, s2), { data: '' });
      await contestar(A, await unir({ wc: W2.wc }, s2), { data: '' });
      onHandlers.get('ssh:resize')({ sender: W.wc }, s2, 70, 20);
      onHandlers.get('ssh:resize')({ sender: W2.wc }, s2, 90, 30);
      onHandlers.get('ssh:send-data')({ sender: W.wc }, s2, 'y');
      assert.strictEqual(registry.conductorOf(s2), W.wc);
      assert.deepStrictEqual(registry.ptySizeOf(s2), { cols: 70, rows: 20 });
      const antes = releases(A).length;
      W.wc.morir();
      ipc.detachWebClient(W.wc);
      assert.strictEqual(registry.conductorOf(s2), A.wc);
      assert.deepStrictEqual(registry.ptySizeOf(s2), { cols: 200, rows: 50 });
      assert.deepStrictEqual(releases(A).slice(antes), [{ sessionId: s2, cols: 200, rows: 50, release: true }], 'la duena no recibio el aviso con otro espectador');
      assert.ok(W2.de('session:size').some(([, p]) => p.sessionId === s2 && p.cols === 200 && p.rows === 50 && !p.release), 'W2 no sigue el tamano de la duena');
      assert.deepStrictEqual(releases(W2), [], 'el release llego a un espectador');
      for (const s of [s1, s2]) registry.release(s);
      W2.wc.morir();
      ipc.detachWebClient(W2.wc);
      A.win.cerrar();
    });

    await check('V13 mirror:command llega al renderer del PC y mirror:state vuelve al navegador', async () => {
      const [A] = nuevas('A-v13');
      const W = navegadorFalso('W-v13');
      ipc.attachWebClient(W.wc);
      try {
        const tabs = [
          { id: 't1', type: 'local-terminal', label: 'Local Terminal', sessionId: 'pty-1', hostConfig: { password: 'nunca' } },
          { id: 't2', type: 'terminal', label: 'Prod', hostId: 'h1', sessionId: 'ssh-2', connecting: false, agent: { id: 'claude', name: 'Claude Code', state: 'working', since: 5, extra: 'x' } },
          { id: 't3', type: 'sftp', label: 'SFTP' },
        ];
        let r = await handlers.get('mirror:report')({ sender: A.wc }, { tabs, layouts: {}, focusedPane: {} });
        assert.ok(r.success && r.data === true, r.error);
        /* Por defecto la primaria (la del arnes); este navegador elige A */
        const def = await handlers.get('mirror:state')({ sender: W.wc });
        assert.strictEqual(def.data.windowId, registry.primary().id);
        assert.ok((await handlers.get('mirror:select')({ sender: W.wc }, registry.entryOf(A.wc).id)).success);
        const st = await handlers.get('mirror:state')({ sender: W.wc });
        assert.ok(st.success, st.error);
        assert.deepStrictEqual(st.data.tabs.map(t => [t.id, t.sessionId]), [['t1', 'pty-1'], ['t2', 'ssh-2']]);
        assert.strictEqual(st.data.windowId, registry.entryOf(A.wc).id);
        assert.ok(!JSON.stringify(st.data).includes('nunca'), 'el estado lleva campos de mas');
        /* El estado del agente segun el PC viaja limpio (la web muestra ese, no su propio escaneo) */
        assert.deepStrictEqual(st.data.tabs.map(t => t.agent), [null, { id: 'claude', name: 'Claude Code', state: 'working', since: 5 }]);
        /* Un navegador que reporta: ignorado */
        r = await handlers.get('mirror:report')({ sender: W.wc }, { tabs: [] });
        assert.strictEqual(r.data, false);
        /* La orden, limpia, al renderer del PC */
        r = await handlers.get('mirror:command')({ sender: W.wc }, { type: 'open-local', tabId: 'nuevo-1', cols: 120, rows: 40, extra: 'x' });
        assert.ok(r.success, r.error);
        assert.deepStrictEqual(A.de('mirror:command').map(([, c]) => c), [{ type: 'open-local', tabId: 'nuevo-1', cols: 120, rows: 40 }]);
        for (const bad of [{ type: 'borrar-todo' }, { type: 'open-local', tabId: '../x' }, { type: 'close', tabIds: [] }, null]) {
          const x = await handlers.get('mirror:command')({ sender: W.wc }, bad);
          assert.strictEqual(x.success, false, JSON.stringify(bad));
        }
        const fromPc = await handlers.get('mirror:command')({ sender: A.wc }, { type: 'open-local', tabId: 'x1' });
        assert.strictEqual(fromPc.success, false, 'el PC pudo mandarse ordenes como navegador');
        assert.strictEqual(A.de('mirror:command').length, 1);
        /* El PC la ejecuta y reporta de nuevo: el navegador recibe el push */
        await handlers.get('mirror:report')({ sender: A.wc }, { tabs: [...tabs, { id: 'nuevo-1', type: 'local-terminal', sessionId: 'pty-9' }] });
        const push = W.de('mirror:state').pop();
        assert.ok(push && push[1].tabs.some(t => t.id === 'nuevo-1' && t.sessionId === 'pty-9'), 'mirror:state no volvio al navegador');
        /* Elegir ventana: otra del PC; una que no existe, no */
        const [B] = nuevas('B-v13');
        await handlers.get('mirror:report')({ sender: B.wc }, { tabs: [{ id: 'b1', type: 'local-terminal', sessionId: 'pty-b' }] });
        const sel = await handlers.get('mirror:select')({ sender: W.wc }, registry.entryOf(B.wc).id);
        assert.ok(sel.success && sel.data.tabs[0].id === 'b1', sel.error);
        assert.strictEqual((await handlers.get('mirror:select')({ sender: W.wc }, 999999)).success, false);
        B.win.cerrar();
        const back = W.de('mirror:state').pop();
        assert.strictEqual(back[1].windowId, registry.primary().id, 'cerrada la elegida, no volvio a la primaria');
      } finally {
        ipc.detachWebClient(W.wc);
        A.win.cerrar();
      }
    });

    await check('V14 web:clients y web:kick solo desde el PC; el PC se entera de cada conexion', async () => {
      const [A] = nuevas('A-v14');
      const W = navegadorFalso('W-v14', 'yo@example.com');
      ipc.attachWebClient(W.wc);
      try {
        const aviso = A.de('web:clients').pop();
        assert.ok(aviso && aviso[1].connected && aviso[1].connected.login === 'yo@example.com', 'el PC no recibio el aviso de conexion');
        const lista = await handlers.get('web:clients')({ sender: A.wc });
        const yo = lista.data.find(c => c.id === W.wc.id);
        assert.ok(yo && yo.login === 'yo@example.com' && /Chrome/.test(yo.userAgent) && Number.isFinite(yo.connectedAt));
        assert.strictEqual((await handlers.get('web:clients')({ sender: W.wc })).success, false);
        assert.strictEqual((await handlers.get('web:kick')({ sender: W.wc }, W.wc.id)).success, false);
        assert.strictEqual(W.wc.desconectados, 0);
        const k = await handlers.get('web:kick')({ sender: A.wc }, W.wc.id);
        assert.ok(k.success && k.data === true);
        assert.strictEqual(W.wc.desconectados, 1, 'web:kick no cerro el socket');
      } finally {
        ipc.detachWebClient(W.wc);
        A.win.cerrar();
      }
    });
  } finally {
    sshService.sendData = real.sendData;
    sshService.resize = real.sresize;
    localShellService.write = real.write;
    localShellService.resize = real.lresize;
    sshService.isConnected = real.isConnected;
    sshService.disconnect = real.disconnect;
    registry.joinTimeoutMs = timeoutAntes;
  }
}

module.exports = { seccionEspectadores };
