/**
 * Seccion BG del arnes del main (scripts/check-main.js): la lista
 * "Background" del dock de Sessions (electron/services/background-sessions.js).
 * Sesiones guardadas (keeper) que ESTE equipo manda al fondo y que tienen que
 * seguir visibles y reabribles hasta que el usuario las acabe.
 *
 *  BG1 cerrar pestana SSH con Keep (ssh:disconnect de una sesion keeper) →
 *      registro con keeperId/kind/hostId/label y alias/color/agente de la fila
 *      del dock; llega a TODAS las ventanas; nada secreto en el archivo.
 *      Una sesion sin keeper no deja registro.
 *  BG2 cerrar pestana local con Keep (local:kill de una guardada) → registro local.
 *  BG3 cerrar una ventana con Keep → registro; con End Sessions → ninguno.
 *  BG4 se quita al re-engancharla en una pestana (_wireStream con keeper),
 *      al acabar (exit 0/76/102 → _keeperEnd; keeper.forget = kill/End),
 *      al matarla en local (local-keeper kill), y al reconciliar con
 *      `keeper list` (local:keeper-list, ssh:keeper-list de ese host).
 *  BG5 persiste: tras "reiniciar" (memoria vacia) la lista sale del archivo;
 *      basura y campos de mas en el archivo se descartan.
 *  BG6 salir con "Restore tabs" apagado → las guardadas van a Background;
 *      encendido → ninguna (vuelven como pestanas).
 *  BG7 forget/rename por window:background-*; rename recorta y limpia.
 *
 * Las sesiones son falsas (entradas en sshService.sessions / localShellService
 * ents+shells), pero los caminos son los de verdad: handlers IPC, registro de
 * ventanas, servicios. El caso con sshd real esta en KP21 (check-keeper.js).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SECRETO = 'contrasena-que-no-debe-llegar-al-archivo';
const CLAVE = '-----BEGIN OPENSSH PRIVATE KEY----- no-debe-salir';

function ventanaFalsa(nombre) {
  const recibido = [];
  const oyentes = new Map();
  let vivo = true;
  const wc = { nombre, send: (canal, ...args) => recibido.push([canal, ...args]), isDestroyed: () => !vivo };
  const win = {
    webContents: wc,
    isDestroyed: () => !vivo,
    isFocused: () => false,
    getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    on: (ev, fn) => { if (!oyentes.has(ev)) oyentes.set(ev, []); oyentes.get(ev).push(fn); return win; },
    once: (ev, fn) => win.on(ev, fn),
    cerrar: () => { vivo = false; for (const fn of oyentes.get('closed') || []) fn(); },
  };
  return { win, wc, recibido, de: (c) => recibido.filter(([x]) => x === c) };
}

async function seccionBackground({ check, ROOT, handlers }) {
  const E = (...p) => require(path.join(ROOT, 'electron', ...p));
  const registry = E('window-registry.js');
  const ipc = E('ipc-handlers.js');
  const bg = E('services', 'background-sessions.js');
  const sshService = E('services', 'ssh-service.js');
  const localShellService = E('services', 'local-shell-service.js');
  const keeperService = E('services', 'keeper-service.js');
  const localKeeper = E('services', 'local-keeper.js');
  const storeService = E('services', 'store-service.js');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termilab-bg-'));
  const archivo = path.join(dir, 'background-sessions.json');
  bg.file = archivo;
  bg._reset();
  const call = async (canal, sender, ...args) => {
    const r = await handlers.get(canal)({ sender }, ...args);
    assert.ok(r && r.success, `${canal} fallo: ${r && r.error}`);
    return r.data;
  };
  let n = 0;
  const id = () => `bgtest${String(++n).padStart(4, '0')}abcdefgh`;
  /* Una sesion SSH guardada falsa: lo que ssh-service tendria tras conectar */
  const sshFalsa = (sid, keeperId, extra = {}) => {
    sshService.sessions.set(sid, {
      keeper: { bin: '/x', session: { id: keeperId, create: true } },
      config: { sessionKey: `tab-${sid}`, hostId: 'host-bg', label: 'Mi Servidor', host: '10.0.0.9', username: 'derek', password: SECRETO, privateKey: CLAVE, passphrase: SECRETO },
      client: { end() {}, removeAllListeners() {} },
      stream: { close() {}, removeAllListeners() {} },
      ...extra,
    });
  };
  const localFalsa = (sid, keeperId) => {
    localShellService.ents.set(sid, { pty: { kill() {} }, kept: { id: keeperId, bin: '/x', sessionKey: `tab-${sid}` }, closing: false });
    localShellService.shells.set(sid, { kill() {} });
  };
  const A = ventanaFalsa('A-bg');
  const B = ventanaFalsa('B-bg');
  registry.addWindow(A.win);
  registry.addWindow(B.win);
  const ultima = (V) => { const l = V.de('window:background-sessions'); return l.length ? l[l.length - 1][1] : null; };

  try {
    await check('BG1 cerrar pestana SSH con Keep → registro (alias/color/agente de la fila), a todas las ventanas, sin secretos; sin keeper no hay registro', async () => {
      const k = id();
      sshFalsa('s-bg1', k);
      /* La ventana A reporta su fila, con agente */
      await call('window:agents-report', A.wc, [{ tabId: 't1', kind: 'ssh', connected: true, title: 'x', host: 'Mi Servidor', alias: 'refactor', color: '#AA3311', agentId: 'claude', name: 'Claude Code', state: 'working', since: Date.now(), sessionId: 's-bg1' }]);
      await call('ssh:disconnect', A.wc, 's-bg1');
      const l = bg.list();
      assert.strictEqual(l.length, 1, JSON.stringify(l));
      const r = l[0];
      assert.deepStrictEqual(
        { keeperId: r.keeperId, sessionKey: r.sessionKey, kind: r.kind, hostId: r.hostId, label: r.label, alias: r.alias, color: r.color, agent: r.agent },
        { keeperId: k, sessionKey: 'tab-s-bg1', kind: 'ssh', hostId: 'host-bg', label: 'Mi Servidor', alias: 'refactor', color: '#aa3311', agent: { id: 'claude', name: 'Claude Code' } });
      assert.ok(Math.abs(r.detachedAt - Date.now()) < 5000);
      assert.ok(!sshService.sessions.has('s-bg1'), 'la sesion no se desconecto');
      for (const V of [A, B]) {
        const got = ultima(V);
        assert.ok(got && got.length === 1 && got[0].keeperId === k, `${V.wc.nombre} no recibio la lista: ${JSON.stringify(got)}`);
      }
      const disco = fs.readFileSync(archivo, 'utf-8');
      for (const s of [SECRETO, CLAVE, '10.0.0.9', 'password', 'privateKey', 'passphrase', 'username']) {
        assert.ok(!disco.includes(s), `el archivo contiene ${s}`);
      }
      assert.strictEqual(fs.statSync(archivo).mode & 0o777, 0o600, 'el archivo no es 0600');
      /* Sin keeper: nada */
      sshService.sessions.set('s-bg1b', { keeper: null, config: { sessionKey: 'x', hostId: 'h' }, client: { end() {}, removeAllListeners() {} }, stream: null });
      await call('ssh:disconnect', A.wc, 's-bg1b');
      assert.strictEqual(bg.list().length, 1, 'una sesion sin keeper dejo registro');
    });

    await check('BG2 cerrar pestana local con Keep (local:kill de una guardada) → registro local', async () => {
      const k = id();
      localFalsa('l-bg2', k);
      await call('window:agents-report', B.wc, [{ tabId: 't2', kind: 'local', connected: true, title: 'Local', host: 'Local Terminal', alias: null, sessionId: 'l-bg2' }]);
      await call('local:kill', B.wc, 'l-bg2');
      const r = bg.list().find(x => x.keeperId === k);
      assert.ok(r, JSON.stringify(bg.list()));
      assert.deepStrictEqual({ kind: r.kind, hostId: r.hostId, label: r.label, agent: r.agent, sessionKey: r.sessionKey }, { kind: 'local', hostId: null, label: 'Local Terminal', agent: null, sessionKey: 'tab-l-bg2' });
      assert.ok(!localShellService.shells.has('l-bg2'));
      localShellService.ents.delete('l-bg2');
    });

    await check('BG3 cerrar ventana con Keep → registro; con End Sessions → ninguno', async () => {
      const C = ventanaFalsa('C-bg');
      ipc.attachWindow(C.win);
      const k = id();
      sshFalsa('s-bg3', k);
      registry.claim('s-bg3', C.wc);
      await call('window:agents-report', C.wc, [{ tabId: 't3', kind: 'ssh', host: 'Mi Servidor', alias: 'deploy', sessionId: 's-bg3', title: 'x' }]);
      C.win.cerrar();
      await new Promise(r => setTimeout(r, 50));
      const r = bg.list().find(x => x.keeperId === k);
      assert.ok(r && r.alias === 'deploy', `cerrar con Keep no lo registro: ${JSON.stringify(bg.list())}`);
      assert.ok(ultima(A).some(x => x.keeperId === k), 'A no se entero');

      const D = ventanaFalsa('D-bg');
      ipc.attachWindow(D.win);
      const k2 = id();
      sshFalsa('s-bg3b', k2);
      registry.claim('s-bg3b', D.wc);
      ipc.endKeptWhenClosed(D.win);
      D.win.cerrar();
      await new Promise(r => setTimeout(r, 200));
      assert.ok(!bg.has(k2), 'End Sessions lo dejo en Background');
      sshService.sessions.delete('s-bg3b');
    });

    await check('BG4 se quita: re-enganche, exit 0/76/102, kill/End (forget), kill local, y reconciliar con keeper list', async () => {
      const ks = Array.from({ length: 7 }, id);
      for (const [i, k] of ks.entries()) bg.noteDetach(`x${i}`, { kind: i >= 5 ? 'local' : 'ssh', keeperId: k, sessionKey: `k${i}`, hostId: i >= 5 ? null : (i === 4 ? 'host-otro' : 'host-bg'), label: 'L' });
      /* Re-enganchado en una pestana: el stream del attach pasa por _wireStream */
      const stream = { _termilabKeeper: { bin: '/x', session: { id: ks[0] } }, on() {}, stderr: { on() {} } };
      sshService._wireStream('s-wire', {}, stream);
      assert.ok(!bg.has(ks[0]), 're-engancharla no la quito');
      /* El keeper dice que se acabo */
      const s = { exitCode: 102, keeper: { session: { id: ks[1] } }, keeperStderr: '' };
      sshService._keeperEnd('s-gone', s);
      assert.ok(!bg.has(ks[1]), 'exit 102 (gone) no la quito');
      sshService._keeperEnd('s-gone', { ...s, exitCode: 76, keeper: { session: { id: ks[2] } } });
      assert.ok(!bg.has(ks[2]), 'exit 76 (killed) no la quito');
      /* kill / End del keeper remoto acaban en forget */
      keeperService.forget(ks[3]);
      assert.ok(!bg.has(ks[3]), 'forget (kill/End) no la quito');
      /* kill local con un "binario" que sale 0 */
      const bin = path.join(dir, 'keeper-falso');
      fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      await localKeeper.kill(bin, ks[5]);
      assert.ok(!bg.has(ks[5]), 'el kill local no la quito');
      /* Reconciliar: local:keeper-list sin ks[6] → fuera */
      const realList = localShellService.keeperList;
      localShellService.keeperList = async () => ({ supported: true, installed: true, rows: [{ id: 'otraqueexiste1' }] });
      try { await call('local:keeper-list', A.wc); } finally { localShellService.keeperList = realList; }
      assert.ok(!bg.has(ks[6]), 'local:keeper-list no reconcilio');
      /* ssh:keeper-list de host-bg: solo toca ese host */
      const kVive = id();
      bg.noteDetach('y', { kind: 'ssh', keeperId: kVive, hostId: 'host-bg', label: 'L' });
      const kMuerta = id();
      bg.noteDetach('z', { kind: 'ssh', keeperId: kMuerta, hostId: 'host-bg', label: 'L' });
      sshFalsa('s-list', 'controlnokeeper', { keeper: null });
      const realSsh = sshService.keeperList;
      sshService.keeperList = async () => ({ installed: true, rows: [{ id: kVive }] });
      try { await call('ssh:keeper-list', A.wc, 's-list'); } finally { sshService.keeperList = realSsh; sshService.sessions.delete('s-list'); }
      assert.ok(bg.has(kVive), 'reconciliar quito una que sigue');
      assert.ok(!bg.has(kMuerta), 'ssh:keeper-list no quito la que ya no esta');
      assert.ok(bg.has(ks[4]), 'reconciliar host-bg toco otro host');
    });

    await check('BG5 persiste tras reiniciar; basura y campos de mas del archivo se descartan', async () => {
      const antes = bg.list();
      assert.ok(antes.length >= 2, JSON.stringify(antes));
      bg._reset();
      assert.deepStrictEqual(bg.list(), antes, 'tras reiniciar la lista no es la misma');
      /* Otro proceso (un reinicio de verdad): instancia nueva sobre el mismo archivo */
      const otra = new bg.BackgroundSessions();
      otra.file = archivo;
      assert.deepStrictEqual(otra.list(), antes);
      const crudo = JSON.parse(fs.readFileSync(archivo, 'utf-8'));
      crudo.sessions.push({ keeperId: '../../etc', kind: 'ssh' }, 'basura', { keeperId: id(), kind: 'ssh', label: 'x', password: SECRETO, config: { privateKey: CLAVE } });
      fs.writeFileSync(archivo, JSON.stringify(crudo));
      bg._reset();
      const l = bg.list();
      assert.strictEqual(l.length, antes.length + 1, JSON.stringify(l));
      assert.ok(!JSON.stringify(l).includes(SECRETO) && !JSON.stringify(l).includes(CLAVE), 'un campo de mas del archivo llego a la lista');
      bg.rename(l[0].keeperId, l[0].alias || '');   // reescribe el archivo limpio
      assert.ok(!fs.readFileSync(archivo, 'utf-8').includes(SECRETO), 'el campo de mas volvio al disco');
    });

    await check('BG6 salir: "Restore tabs" apagado → las guardadas a Background; encendido → ninguna', async () => {
      const realSettings = storeService.getSettings;
      const k1 = id(); const k2 = id();
      try {
        sshFalsa('s-q1', k1);
        localFalsa('l-q2', k2);
        storeService.getSettings = async () => ({ general: { restoreTabs: true } });
        let cap = ipc.captureKeptForQuit();
        assert.deepStrictEqual(cap.map(([sid]) => sid).sort(), ['l-q2', 's-q1']);
        assert.strictEqual(await ipc.noteKeptOnQuit(cap), 0);
        assert.ok(!bg.has(k1) && !bg.has(k2), 'con Restore tabs encendido se listaron');
        storeService.getSettings = async () => ({ general: { restoreTabs: false } });
        cap = ipc.captureKeptForQuit();
        /* Lo de despues (disconnectAll) ya no importa: se capturo antes */
        sshService.sessions.delete('s-q1');
        localShellService.shells.delete('l-q2');
        localShellService.ents.delete('l-q2');
        assert.strictEqual(await ipc.noteKeptOnQuit(cap), 2);
        assert.ok(bg.has(k1) && bg.has(k2), 'con Restore tabs apagado no se listaron');
      } finally {
        storeService.getSettings = realSettings;
        sshService.sessions.delete('s-q1');
        localShellService.shells.delete('l-q2');
        localShellService.ents.delete('l-q2');
      }
    });

    await check('BG7 window:background-sessions / -forget / -rename', async () => {
      const k = id();
      bg.noteDetach('w', { kind: 'ssh', keeperId: k, hostId: 'h', label: 'L' });
      const lista = await call('window:background-sessions', A.wc);
      assert.ok(lista.some(x => x.keeperId === k));
      assert.strictEqual(await call('window:background-rename', B.wc, k, `  nombre\u0007 ${'x'.repeat(80)}`), true);
      const r = bg.list().find(x => x.keeperId === k);
      assert.ok(r.alias.length <= 40 && !/\u0007/.test(r.alias) && r.alias.startsWith('nombre'), r.alias);
      assert.ok(ultima(A).find(x => x.keeperId === k).alias === r.alias, 'el rename no llego a A');
      assert.strictEqual(await call('window:background-forget', A.wc, k), true);
      assert.ok(!bg.has(k));
      assert.ok(!ultima(B).some(x => x.keeperId === k), 'forget no llego a B');
      assert.strictEqual(await call('window:background-forget', A.wc, k), false);
    });
  } finally {
    A.win.cerrar();
    B.win.cerrar();
    bg._reset();
    bg.file = null;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { seccionBackground };
