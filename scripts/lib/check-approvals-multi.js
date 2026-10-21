/**
 * Seccion AM del arnes del main (scripts/check-main.js): avisos que esperan
 * a una persona cuando hay navegadores del espejo web conectados.
 *
 * Con un window-registry de verdad, ventanas de PC falsas y webContents
 * virtuales (id >= 1000000, isWeb, login), como los registra el gateway:
 *
 *  - AM1-AM4: aprobacion de comandos destructivos de agentes (approval.js):
 *    el aviso llega a la ventana de PC elegida y a TODOS los navegadores; la
 *    primera respuesta gana y dice quien ('pc' / 'web:<login>'); los demas
 *    reciben cancel; una respuesta tardia o de otro cliente se ignora; el
 *    timeout sigue bloqueando; un cliente destruido se ignora.
 *  - AM5: agent-log guarda answeredBy.
 *  - AM6-AM8: huella nueva del servidor SSH (host-key-service.js), misma regla.
 *  - AM9: ciclo de vida con la web activa: dialogo al cerrar la ultima
 *    ventana (Linux/Windows), app:quit, segunda instancia muestra la oculta.
 *
 * Solo esta seccion: TERMILAB_CHECK_ONLY=AM node scripts/check-main.js
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(10); }
  return fn();
}

let nextWebId = 1000000;

/* Una ventana de PC falsa (BrowserWindow con su webContents) */
function pcWindow(name, { focused = false } = {}) {
  const sent = [];
  let vivo = true;
  const wc = { name, id: 10 + sent.length, isDestroyed: () => !vivo, send: (ch, p) => sent.push([ch, p]) };
  const win = { name, webContents: wc, isDestroyed: () => !vivo, isFocused: () => focused };
  return { name, win, wc, sent, kill: () => { vivo = false; }, focus: (f) => { focused = f; } };
}

/* Un navegador: el webContents virtual del gateway (sin BrowserWindow) */
function webClient(login) {
  const sent = [];
  let vivo = true;
  const wc = { id: ++nextWebId, isWeb: true, login, isDestroyed: () => !vivo, send: (ch, p) => sent.push([ch, p]) };
  return { name: `web:${login}`, wc, win: wc, sent, kill: () => { vivo = false; } };
}

const of = (c, ch) => c.sent.filter(([x]) => x === ch).map(([, p]) => p);

/* Clave ed25519 en formato de cable SSH (string tipo + string clave) */
function ed25519Blob() {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const str = (b) => { const len = Buffer.alloc(4); len.writeUInt32BE(b.length); return Buffer.concat([len, b]); };
  return Buffer.concat([str(Buffer.from('ssh-ed25519')), str(raw)]);
}

async function seccionAprobacionesMulti({ check, ROOT, handlers }) {
  const { WindowRegistry } = require(path.join(ROOT, 'electron', 'window-registry.js'));
  const { ApprovalBroker, APPROVAL_TIMEOUT_MS } = require(path.join(ROOT, 'electron', 'agent', 'approval.js'));
  const { AgentLog } = require(path.join(ROOT, 'electron', 'agent', 'agent-log.js'));
  const hkInstance = require(path.join(ROOT, 'electron', 'services', 'host-key-service.js'));
  const storeService = require(path.join(ROOT, 'electron', 'services', 'store-service.js'));
  const HostKeyService = hkInstance.constructor;

  const montaje = () => {
    const reg = new WindowRegistry();
    const add = (c) => { reg.addWindow(c.win); return c; };
    return { reg, add };
  };
  const ask = (b) => b.ask({ client: 'Claude Code', host: 'produccion', tool: 'run_command', command: 'dropdb ventas', category: 'databases', label: 'database drop', reason: 'dropdb' });

  await check('AM1 aprobacion: llega a la ventana de PC enfocada y a TODOS los navegadores (no a otra de PC); listVirtual los ve', async () => {
    const { reg, add } = montaje();
    const a = add(pcWindow('A'));
    const c = add(pcWindow('C', { focused: true }));
    const w1 = add(webClient('derek'));
    const w2 = add(webClient('derek'));
    assert.deepStrictEqual(reg.listVirtual().map(e => e.wc), [w1.wc, w2.wc]);
    assert.strictEqual(reg.isVirtual(c.wc), false);
    const b = new ApprovalBroker();
    b.setRouter(reg);
    const presented = [];
    b.present = (entry) => presented.push(entry.wc);
    const p = ask(b);
    assert.ok(await until(() => of(c, 'agent:approval-prompt').length === 1 && of(w1, 'agent:approval-prompt').length === 1 && of(w2, 'agent:approval-prompt').length === 1));
    assert.strictEqual(a.sent.length, 0, 'fue a la ventana de PC no enfocada');
    const id = of(c, 'agent:approval-prompt')[0].requestId;
    assert.strictEqual(of(w1, 'agent:approval-prompt')[0].requestId, id);
    assert.deepStrictEqual(presented, [c.wc], 'present() solo para la ventana de PC');
    assert.strictEqual(b.respond(id, true, a.wc), false, 'una ventana a la que no se pregunto pudo aprobar');
    b.respond(id, false, c.wc);
    assert.deepStrictEqual(await p, { approved: false, reason: 'blocked', by: 'pc' });
  });

  await check('AM2 aprobacion: gana la primera respuesta (web:<login>); los demas reciben cancel; la tardia se ignora', async () => {
    const { reg, add } = montaje();
    const a = add(pcWindow('A', { focused: true }));
    const w1 = add(webClient('derek@github'));
    const w2 = add(webClient('derek@github'));
    const b = new ApprovalBroker();
    b.setRouter(reg);
    const p = ask(b);
    await until(() => of(w1, 'agent:approval-prompt').length === 1);
    const id = of(w1, 'agent:approval-prompt')[0].requestId;
    assert.strictEqual(b.respond(id, true, w1.wc), true);
    assert.deepStrictEqual(await p, { approved: true, reason: 'approved', by: 'web:derek@github' });
    assert.deepStrictEqual(of(a, 'agent:approval-cancel'), [{ requestId: id, reason: 'answered', by: 'web:derek@github' }]);
    assert.strictEqual(of(w2, 'agent:approval-cancel').length, 1);
    assert.strictEqual(of(w1, 'agent:approval-cancel').length, 0, 'quien respondio recibio cancel');
    assert.strictEqual(b.respond(id, false, a.wc), false, 'la respuesta tardia conto');
    assert.strictEqual(b.respond(id, true, w2.wc), false);
    assert.strictEqual(b.pendingCount(), 0);
  });

  await check('AM3 aprobacion: el timeout sigue bloqueando (120 s por defecto) y cierra el modal en todos', async () => {
    assert.strictEqual(APPROVAL_TIMEOUT_MS, 120000);
    assert.strictEqual(new ApprovalBroker().timeoutMs, 120000);
    const { reg, add } = montaje();
    const a = add(pcWindow('A', { focused: true }));
    const w1 = add(webClient('derek'));
    const b = new ApprovalBroker();
    b.setRouter(reg);
    b.timeoutMs = 80;
    const r = await ask(b);
    assert.deepStrictEqual(r, { approved: false, reason: 'timeout' });
    for (const c of [a, w1]) assert.deepStrictEqual(c.sent.map(([ch]) => ch), ['agent:approval-prompt', 'agent:approval-cancel'], c.name);
    assert.strictEqual(of(w1, 'agent:approval-cancel')[0].reason, 'timeout');
  });

  await check('AM4 aprobacion: un cliente destruido se ignora; solo navegadores; se van todos -> Block', async () => {
    const { reg, add } = montaje();
    const a = add(pcWindow('A', { focused: true }));
    const w1 = add(webClient('derek'));
    const w2 = add(webClient('derek'));
    w2.kill();
    const b = new ApprovalBroker();
    b.setRouter(reg);
    const p = ask(b);
    await until(() => of(w1, 'agent:approval-prompt').length === 1);
    assert.strictEqual(w2.sent.length, 0, 'se envio a un cliente destruido');
    const id = of(a, 'agent:approval-prompt')[0].requestId;
    /* El navegador se cierra: el aviso sigue en el PC, sin tiempo nuevo ni Block */
    w1.kill();
    b.rejectFor(w1.wc);
    assert.strictEqual(b.pendingCount(), 1, 'cerrar un navegador bloqueo');
    assert.strictEqual(b.respond(id, true, w1.wc), false, 'respondio un cliente ya ido');
    b.respond(id, true, a.wc);
    assert.deepStrictEqual(await p, { approved: true, reason: 'approved', by: 'pc' });

    /* Sin ventana de PC viva (todas ocultas no cuentan como muertas, pero aqui no hay) */
    const solo = montaje();
    const w3 = solo.add(webClient('derek'));
    const b2 = new ApprovalBroker();
    b2.setRouter(solo.reg);
    const q = ask(b2);
    await until(() => of(w3, 'agent:approval-prompt').length === 1);
    w3.kill();
    solo.reg.removeWindow(w3.wc);
    b2.rejectFor(w3.wc);
    assert.deepStrictEqual(await q, { approved: false, reason: 'no-window' });
  });

  await check('AM5 agent-log guarda quien respondio (answeredBy)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlam-'));
    try {
      const log = new AgentLog(() => dir);
      await log.add({ tool: 'run_command (approved)', host: 'h', command: 'dropdb x', category: 'databases', ok: true, answeredBy: 'web:derek' });
      await log.add({ tool: 'run_command (blocked)', host: 'h', command: 'dropdb x', category: 'databases', ok: false });
      const list = JSON.parse(fs.readFileSync(path.join(dir, 'agent-logs.json'), 'utf-8'));
      const by = list.map(e => e.answeredBy || null).sort();
      assert.deepStrictEqual(by, [null, 'web:derek']);
      const src = fs.readFileSync(path.join(ROOT, 'electron', 'agent', 'agent-service.js'), 'utf-8');
      assert.ok(/entry\.answeredBy = answer\.by/.test(src), 'agent-service no pasa answer.by al log');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /* ── Huella del servidor SSH ── */
  const realGet = storeService.getKnownHosts;
  const realSave = storeService.saveKnownHost;
  const saved = [];
  storeService.getKnownHosts = async () => [];
  storeService.saveKnownHost = async (e) => { saved.push(e); };
  try {
    const montajeHK = () => {
      const { reg, add } = montaje();
      const hk = new HostKeyService();
      hk.setRouter(reg);
      return { reg, add, hk };
    };

    await check('AM6 huella: a la ventana duena de la sesion y a todos los navegadores; gana la primera, cancel al resto', async () => {
      const { reg, add, hk } = montajeHK();
      const a = add(pcWindow('A', { focused: true }));
      const s = add(pcWindow('S'));
      const w1 = add(webClient('derek'));
      const w2 = add(webClient('derek'));
      reg.claim('sess-am6', s.win);
      saved.length = 0;
      const v = hk.verify('am6.example', 22, ed25519Blob(), { sessionId: 'sess-am6' });
      assert.ok(await until(() => [s, w1, w2].every(c => of(c, 'ssh:host-key-prompt').length === 1)), 'no llego a todos');
      assert.strictEqual(a.sent.length, 0, 'fue a la ventana enfocada en vez de a la duena');
      const id = of(s, 'ssh:host-key-prompt')[0].requestId;
      assert.strictEqual(await hk.respond(id, true, a.wc), false, 'una ventana a la que no se pregunto respondio');
      assert.strictEqual(await hk.respond(id, true, w2.wc), true);
      assert.strictEqual(await v, true);
      assert.strictEqual(saved.length, 1);
      assert.deepStrictEqual(of(s, 'ssh:host-key-prompt-cancel'), [{ requestId: id, reason: 'answered' }]);
      assert.strictEqual(of(w1, 'ssh:host-key-prompt-cancel').length, 1);
      assert.strictEqual(of(w2, 'ssh:host-key-prompt-cancel').length, 0);
      assert.strictEqual(await hk.respond(id, false, s.wc), false, 'la respuesta tardia conto');
      assert.strictEqual(saved.length, 1);
    });

    await check('AM7 huella: dos respuestas a la vez -> solo la primera (aunque guardar tarde); timeout rechaza y cierra en todos', async () => {
      const { reg, add, hk } = montajeHK();
      const s = add(pcWindow('S', { focused: true }));
      const w1 = add(webClient('derek'));
      reg.claim('sess-am7', s.win);
      saved.length = 0;
      let soltar;
      storeService.saveKnownHost = (e) => new Promise(r => { soltar = () => { saved.push(e); r(); }; });
      const v = hk.verify('am7.example', 22, ed25519Blob(), { sessionId: 'sess-am7' });
      await until(() => of(w1, 'ssh:host-key-prompt').length === 1);
      const id = of(w1, 'ssh:host-key-prompt')[0].requestId;
      const r1 = hk.respond(id, true, w1.wc);
      const r2 = hk.respond(id, false, s.wc);
      assert.strictEqual(await r2, false, 'la segunda respuesta conto mientras se guardaba');
      await until(() => !!soltar);
      soltar();
      assert.strictEqual(await r1, true);
      assert.strictEqual(await v, true);
      storeService.saveKnownHost = async (e) => { saved.push(e); };

      assert.strictEqual(hk.timeoutMs, 120000);
      hk.timeoutMs = 80;
      const before = [s, w1].map(c => c.sent.length);
      assert.strictEqual(await hk.verify('am7b.example', 22, ed25519Blob(), { sessionId: 'sess-am7' }), false);
      for (const [i, c] of [s, w1].entries()) {
        assert.deepStrictEqual(c.sent.slice(before[i]).map(([ch, p]) => [ch, p.reason]),
          [['ssh:host-key-prompt', 'unknown'], ['ssh:host-key-prompt-cancel', 'timeout']], c.name);
      }
    });

    await check('AM8 huella: cliente destruido se ignora; cerrar un navegador no rechaza; cerrar la duena con un navegador vivo tampoco', async () => {
      const { reg, add, hk } = montajeHK();
      const s = add(pcWindow('S', { focused: true }));
      const w1 = add(webClient('derek'));
      const w2 = add(webClient('derek'));
      w2.kill();
      reg.claim('sess-am8', s.win);
      const v = hk.verify('am8.example', 22, ed25519Blob(), { sessionId: 'sess-am8' });
      await until(() => of(w1, 'ssh:host-key-prompt').length === 1);
      assert.strictEqual(w2.sent.length, 0, 'se envio a un cliente destruido');
      const id = of(s, 'ssh:host-key-prompt')[0].requestId;
      /* La ventana del PC se cierra: el navegador sigue pudiendo decidir */
      s.kill();
      hk.rejectFor(s.wc);
      assert.strictEqual(hk._pending.size, 1, 'cerrar la duena rechazo con un navegador vivo');
      assert.strictEqual(await hk.respond(id, true, s.wc), false, 'respondio un cliente ya ido');
      assert.strictEqual(await hk.respond(id, false, w1.wc), true);
      assert.strictEqual(await v, false);
      /* Solo un navegador y se va: rechazo inmediato */
      const v2 = hk.verify('am8b.example', 22, ed25519Blob(), { sessionId: null });
      const w3 = add(webClient('otro'));
      const v3 = hk.verify('am8c.example', 22, ed25519Blob(), { sessionId: null });
      await until(() => of(w3, 'ssh:host-key-prompt').length === 1);
      w3.kill();
      hk.rejectFor(w3.wc);
      w1.kill();
      hk.rejectFor(w1.wc);
      assert.strictEqual(await v3, false);
      assert.strictEqual(await v2, false);
      assert.strictEqual(hk._pending.size, 0);
    });
  } finally {
    storeService.getKnownHosts = realGet;
    storeService.saveKnownHost = realSave;
  }

  await check('AM9 ciclo de vida: cerrar la ultima ventana con la web activa pregunta (Keep running / Quit); app:quit; fuera de la web y de Android', async () => {
    const { cargaMain } = require('./check-main-lifecycle');
    const cases = [[0, 'hide'], [1, 'quit']];
    for (const [answer, want] of cases) {
      const L = cargaMain(ROOT, { respuesta: () => answer });
      const llamadas = [];
      const win = { isDestroyed: () => false, isVisible: () => true, hide: () => llamadas.push('hide') };
      L.T.windows.add(win);
      L.T.setWebServer({ isRunning: () => true });
      let prevented = false;
      const ev = { preventDefault: () => { prevented = true; } };
      const plat = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'linux' });
      try {
        assert.strictEqual(L.T.hideForWeb(win, ev), true);
        /* Un segundo cierre mientras pregunta no abre otro dialogo */
        assert.strictEqual(L.T.hideForWeb(win, { preventDefault: () => {} }), true);
      } finally {
        Object.defineProperty(process, 'platform', plat);
      }
      assert.ok(prevented, 'no impidio el cierre');
      await sleep(20);
      assert.strictEqual(L.dialogos.length, 1);
      assert.deepStrictEqual(L.dialogos[0].buttons, ['Keep running for remote access', 'Quit Termilab']);
      assert.strictEqual(L.dialogos[0].defaultId, 0);
      assert.strictEqual(L.dialogos[0].cancelId, 0);
      if (want === 'hide') { assert.deepStrictEqual(llamadas, ['hide']); assert.strictEqual(L.app.quitCalls, 0); }
      else { assert.deepStrictEqual(llamadas, []); assert.strictEqual(L.app.quitCalls, 1); }
      /* Sin web activa: se cierra como siempre */
      L.T.setWebServer(null);
      assert.strictEqual(L.T.hideForWeb(win, ev), false);
      /* Segunda instancia: la ventana oculta vuelve */
      if (want === 'hide') {
        L.T.markLaunched();
        const shown = [];
        const hidden = { isDestroyed: () => false, isFocused: () => false, isMinimized: () => false, show: () => shown.push('show'), focus: () => shown.push('focus') };
        L.T.windows.clear();
        L.T.windows.add(hidden);
        L.T.onSecondInstance();
        assert.deepStrictEqual(shown, ['show', 'focus']);
      }
      L.T.windows.clear();
    }

    /* app:quit: las tres piezas, y fuera de la web y del shim de Android */
    const fn = handlers.get('app:quit');
    assert.ok(fn, 'app:quit sin registrar');
    const electron = require('electron');
    const realQuit = electron.app.quit;
    let quits = 0;
    electron.app.quit = () => { quits++; };
    try {
      const r = await fn({});
      assert.deepStrictEqual(r, { success: true, data: true });
      await until(() => quits === 1, 500);
      assert.strictEqual(quits, 1);
    } finally {
      electron.app.quit = realQuit;
    }
    const preload = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf-8');
    assert.ok(/lifecycle:\s*\{\s*quit: \(\) => invoke\('app:quit'\)/.test(preload), 'preload no expone lifecycle.quit');
    const { WEB_CHANNELS } = require(path.join(ROOT, 'electron', 'web', 'gateway.js'));
    assert.ok(!WEB_CHANNELS.has('app:quit'), 'app:quit en la lista blanca web');
    const shim = fs.readFileSync(path.join(ROOT, 'mobile', 'web', 'electron-api-shim.js'), 'utf-8');
    assert.ok(/OMITTED_NAMESPACES = \[[^\]]*'lifecycle'/.test(shim), 'el shim no omite lifecycle');
    const ra = fs.readFileSync(path.join(ROOT, 'src', 'components', 'Settings', 'RemoteAccess.jsx'), 'utf-8');
    assert.ok(/lifecycle\.quit\(\)/.test(ra) && />\s*Quit Termilab\s*</.test(ra), 'falta el boton Quit Termilab');
  });
}

module.exports = { seccionAprobacionesMulti };
