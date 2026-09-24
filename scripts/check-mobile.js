#!/usr/bin/env node
/**
 * Arnes del lado Android (fases 1-3). Correrlo con el Node de nodejs-mobile:
 *
 *   npx -y -p node@18 node scripts/check-mobile.js
 *
 * No abre el emulador ni toca el servidor real. Que hace:
 *
 *  M1  preload.js <-> mobile/web/electron-api-shim.js: cada miembro y cada canal
 *      de preload esta en el shim o en la lista EXPLICITA de omitidos.
 *  M2+ Empaqueta mobile/node/main.js con scripts/build-mobile-node.js (el mismo
 *      bundle que va en el APK) y lo arranca con fork() usando el modulo
 *      `bridge` DE VERDAD del plugin vendorizado: fuera de Android ese modulo
 *      habla por process.send, asi que este proceso hace de capa Capacitor y,
 *      como el plugin, TIRA los mensajes sin listener (hallazgo #2 del spike).
 *      La "pagina" es el shim del renderer, importado tal cual.
 *      - ida y vuelta de invoke, fallos limpios de lo que no hay en Android;
 *      - ssh contra un ssh2.Server local con el aviso de clave de host por el
 *        puente, `echo mobile-ok`, lotes de ssh:data y el orden de ssh:close;
 *      - INTEROP: boveda + host con contrasena + clave SSH creados por un
 *        equipo de escritorio (scripts/lib/desktop-device.js, otro proceso) se
 *        abren en el movil, y al reves; contra el servidor de sync falso;
 *      - la DSK (fase 3: solo por env TERMILAB_DSK, que Java saca del Keystore):
 *        secretos en reposo en AES-256-GCM, nunca un device-key.json, un
 *        segundo arranque que sigue desbloqueado, un device-key.json viejo que
 *        Node ignora, una DSK nueva (el unwrap fallo) que obliga a entrar y
 *        desbloquear con el passphrase otra vez, y sin DSK: sin secretos;
 *      - native:sessions: el recuento de sesiones SSH que enciende el
 *        foreground service;
 *      - cancelar un login a medias (el "Cancel" de Android): logout() corta el
 *        sondeo, el login rechaza y signingIn vuelve a false;
 *      - la fila de teclas extra (src/components/Terminal/mobile/keys.js):
 *        secuencias, modo de cursor de aplicacion y Ctrl/Alt pegajosos;
 *      - la cola: lo que Node emite antes del hello llega igual.
 *
 *  La migracion y el borrado de device-key.json son de Java (DeviceKeyResolver):
 *  cd mobile/android && ./gradlew :termilab-native:testDebugUnitTest
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { fork, execFile } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const { fakeServer } = require('./lib/fake-sync-server');
const { startSshTestServer } = require('./lib/ssh-test-server');
const { build } = require('./build-mobile-node');

const BUILTIN_MODULES = path.join(ROOT, 'mobile', 'vendor', 'capacitor-nodejs', 'android', 'src', 'main', 'assets', 'builtin_modules');
const EXPECTED_OMITTED = ['sftp', 'portForward', 'localShell', 'window', 'dialog'];
const DEVICE_NAME = 'Pixel de prueba';
const VERSION = require(path.join(ROOT, 'package.json')).version;

const SECRET_D = 'contrasena-del-host-de-escritorio';
const PRIV_D = '-----BEGIN OPENSSH PRIVATE KEY----- de escritorio';
const PASS_A = 'frase-de-boveda-creada-en-escritorio';
const SECRET_M = 'contrasena-del-host-creado-en-el-movil';
const PASS_B = 'frase-de-boveda-creada-en-el-movil';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termilab-movil-'));
let failures = 0;
const results = [];
const childLogs = [];

async function check(name, fn) {
  try {
    await fn();
    results.push(`  ok   ${name}`);
  } catch (err) {
    failures++;
    results.push(`  FALLA ${name}\n         ${err && err.message}`);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(what, pred, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await pred()) return;
    await sleep(20);
  }
  throw new Error(`timeout esperando: ${what}`);
}

// ─── El "Capacitor" de mentira: fork + el bridge real ───────

function spawnMobile(bundle, { name, dataDir, syncUrl, dsk }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const env = { ...process.env, DATADIR: dataDir, NODE_PATH: BUILTIN_MODULES, TERMILAB_SYNC_URL: syncUrl, TERMILAB_DEVICE_NAME: DEVICE_NAME };
  delete env.SSH_AUTH_SOCK;   // si no, ssh2 prueba el agente real de quien corre esto
  if (dsk) env.TERMILAB_DSK = dsk; else delete env.TERMILAB_DSK;
  const child = fork(bundle, [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const log = [];
  childLogs.push([name, log]);
  child.stdout.on('data', d => log.push(String(d)));
  child.stderr.on('data', d => log.push(String(d)));

  const listeners = new Map();
  const stats = { received: [], dropped: [] };
  let onReady;
  const ready = new Promise(r => { onReady = r; });
  child.on('message', (msg) => {
    if (!msg || typeof msg.channelMessage !== 'string') return;
    const { eventName, eventMessage } = JSON.parse(msg.channelMessage);
    if (msg.channelName === 'APP_CHANNEL') { if (eventName === 'ready') onReady(); return; }
    const args = eventMessage ? JSON.parse(eventMessage) : [];
    stats.received.push([eventName, args[0]]);
    const list = listeners.get(eventName) || [];
    if (!list.length) { stats.dropped.push(eventName); return; }   // como el plugin
    for (const cb of list.slice()) cb(args[0]);
  });
  const exited = new Promise(r => child.once('exit', r));

  const transport = {
    whenReady: () => ready,
    send: async (eventName, payload) => {
      await ready;
      child.send({ channelName: 'EVENT_CHANNEL', channelMessage: JSON.stringify({ eventName, eventMessage: JSON.stringify([payload]) }) });
    },
    addListener: (eventName, cb) => {
      if (!listeners.has(eventName)) listeners.set(eventName, []);
      listeners.get(eventName).push(cb);
      return Promise.resolve({ remove: () => {} });
    },
  };

  // ipc:invoke a pelo (canales que el shim no expone), con su propio espacio de ids.
  let rawSeq = 0;
  const rawInvoke = (channel, ...args) => new Promise((resolve) => {
    const id = `raw-${++rawSeq}`;
    const cb = (msg) => {
      if (!msg || msg.id !== id) return;
      listeners.get('ipc:reply').splice(listeners.get('ipc:reply').indexOf(cb), 1);
      resolve(msg);
    };
    transport.addListener('ipc:reply', cb);
    transport.send('ipc:invoke', { id, channel, args });
  });

  return {
    child, transport, stats, ready, log, rawInvoke,
    resume: () => child.send({ channelName: 'APP_CHANNEL', channelMessage: JSON.stringify({ eventName: 'resume', eventMessage: '[]' }) }),
    stop: async () => { child.kill('SIGTERM'); await exited; },
  };
}

function desktopDevice(syncUrl, request) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, TERMILAB_SYNC_URL: syncUrl };
    execFile(process.execPath, [path.join(__dirname, 'lib', 'desktop-device.js'), JSON.stringify(request)],
      { env, timeout: 60000 }, (err, stdout, stderr) => {
        const line = String(stdout).trim().split('\n').pop();
        let out;
        try { out = JSON.parse(line); } catch (_) { return reject(new Error(`escritorio no devolvio JSON: ${stderr || err}`)); }
        if (!out.ok) return reject(new Error(`escritorio: ${out.error}`));
        resolve(out);
      });
  });
}

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf-8'));
function unsealWithDsk(dsk, b64) {
  const buf = Buffer.from(b64, 'base64');
  assert.strictEqual(buf[0], 1, 'el valor sellado no empieza por la version 0x01');
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(dsk, 'base64'), buf.subarray(1, 13));
  d.setAuthTag(buf.subarray(13, 29));
  return Buffer.concat([d.update(buf.subarray(29)), d.final()]).toString('utf-8');
}

// ─── M1: preload <-> shim ───────────────────────────────────

function loadPreloadApi() {
  let api = null;
  const stub = {
    contextBridge: { exposeInMainWorld: (_n, value) => { api = value; } },
    ipcRenderer: { invoke: async () => null, send: () => {}, on: () => {}, removeListener: () => {}, removeAllListeners: () => {} },
  };
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return stub;
    return realLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(path.join(ROOT, 'electron', 'preload.js'))];
    require(path.join(ROOT, 'electron', 'preload.js'));
  } finally {
    Module._load = realLoad;
  }
  return api;
}

function leaves(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v && typeof v === 'object') Object.assign(out, leaves(v, `${prefix}${k}.`));
    else out[`${prefix}${k}`] = typeof v;
  }
  return out;
}

const CHANNEL_RE = /(?:invoke|send|\.on|removeListener|removeAllListeners)\(\s*'([a-z-]+:[a-z-]+)'/g;
const channelsIn = src => new Set([...src.matchAll(CHANNEL_RE)].map(m => m[1]));

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major !== 18) console.warn(`AVISO: esto es Node ${process.version}; nodejs-mobile es 18.20.4. Usa: npx -y -p node@18 node scripts/check-mobile.js`);

  const shimMod = await import(pathToFileURL(path.join(ROOT, 'mobile', 'web', 'electron-api-shim.js')).href);

  await check('M1a el shim tiene cada miembro de preload.js (mismo tipo) salvo los namespaces omitidos', () => {
    assert.deepStrictEqual([...shimMod.OMITTED_NAMESPACES].sort(), [...EXPECTED_OMITTED].sort(),
      'la lista de omitidos cambio: si es a proposito, cambia tambien EXPECTED_OMITTED aqui');
    const pre = leaves(loadPreloadApi());
    const dead = { whenReady: () => new Promise(() => {}), send: async () => {}, addListener: () => {} };
    const shim = leaves(shimMod.createElectronAPI(dead));
    const missing = [];
    const wrongType = [];
    for (const [key, type] of Object.entries(pre)) {
      if (shimMod.OMITTED_NAMESPACES.includes(key.split('.')[0])) continue;
      if (!(key in shim)) missing.push(key);
      else if (key !== 'platform' && shim[key] !== type) wrongType.push(`${key}: ${shim[key]} != ${type}`);
    }
    const extra = Object.keys(shim).filter(k => !(k in pre));
    const leaked = Object.keys(shim).filter(k => shimMod.OMITTED_NAMESPACES.includes(k.split('.')[0]));
    assert.deepStrictEqual(missing, [], `faltan en el shim: ${missing.join(', ')}`);
    assert.deepStrictEqual(wrongType, [], `tipo distinto: ${wrongType.join(', ')}`);
    assert.deepStrictEqual(extra, [], `el shim tiene miembros que preload no: ${extra.join(', ')}`);
    assert.deepStrictEqual(leaked, [], `el shim expone namespaces omitidos: ${leaked.join(', ')}`);
    assert.strictEqual(shim.platform, 'string');
  });

  await check('M1b cada canal de preload.js (invoke/send/on) esta en el shim o empieza por un prefijo omitido', () => {
    const pre = channelsIn(fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf-8'));
    const shim = channelsIn(fs.readFileSync(path.join(ROOT, 'mobile', 'web', 'electron-api-shim.js'), 'utf-8'));
    assert.ok(pre.size > 50, `solo ${pre.size} canales en preload: la regex ya no los ve`);
    const omitted = c => shimMod.OMITTED_CHANNEL_PREFIXES.some(p => c.startsWith(p));
    const missing = [...pre].filter(c => !shim.has(c) && !omitted(c));
    const unknown = [...shim].filter(c => !pre.has(c));
    const leaked = [...shim].filter(omitted);
    assert.deepStrictEqual(missing, [], `canales de preload sin cubrir: ${missing.join(', ')}`);
    assert.deepStrictEqual(unknown, [], `canales del shim que preload no tiene: ${unknown.join(', ')}`);
    assert.deepStrictEqual(leaked, [], `canales omitidos presentes en el shim: ${leaked.join(', ')}`);
  });

  // ─── El bundle, y los servidores ──────────────────────────
  const bundle = await build(path.join(tmp, 'nodejs', 'index.js'));
  const srvA = fakeServer();
  const srvB = fakeServer();
  await srvA.listen();
  await srvB.listen();
  const sshd = await startSshTestServer({ user: 'termilab', password: 'mobile' });
  const dskA = crypto.randomBytes(32).toString('base64');

  // ─── Dispositivo movil A (DSK por env) ────────────────────
  const dirA = path.join(tmp, 'movil-A');
  const A = spawnMobile(bundle, { name: 'movil-A', dataDir: dirA, syncUrl: srvA.url(), dsk: dskA });
  const openedUrls = [];
  const api = shimMod.createElectronAPI(A.transport, { onOpenUrl: url => openedUrls.push(url) });

  await check('M2 arranque + invoke de ida y vuelta (llamadas hechas ANTES del hello incluidas)', async () => {
    // Se piden antes de que el puente este listo: el shim las encola.
    const [info, version, hosts] = await Promise.all([api.system.getInfo(), api.updater.getVersion(), api.store.getHosts()]);
    assert.strictEqual(info.hostname, DEVICE_NAME, `os.hostname() sin parchear: ${info.hostname}`);
    assert.strictEqual(info.username, 'termilab', `os.userInfo() sin parchear: ${info.username}`);
    assert.strictEqual(version, VERSION);
    assert.deepStrictEqual(hosts, []);
    const saved = await api.store.saveHost({ label: 'prueba', hostname: 'h.example', port: 22, username: 'u', authType: 'password' });
    assert.ok(saved && saved.id, 'saveHost no devolvio el host con id');
    const again = await api.store.getHosts();
    assert.deepStrictEqual(again.map(h => h.id), [saved.id]);
    await api.store.deleteHost(saved.id);
    assert.deepStrictEqual(await api.store.getHosts(), []);
    assert.ok(fs.existsSync(path.join(dirA, 'data')), 'el almacen no escribio en DATADIR/data');
  });

  await check('M3 lo que no existe en Android falla limpio (sobre de error, sin tumbar Node)', async () => {
    await assert.rejects(api.store.importKey(), /not available on Android/);
    await assert.rejects(api.knownHosts.importFromSsh(), /No known_hosts file/);
    const spawn = await A.rawInvoke('local:spawn', { cols: 80, rows: 24 });
    assert.ok(spawn.result && spawn.result.success === false && /node-pty/.test(spawn.result.error), `local:spawn: ${JSON.stringify(spawn)}`);
    const dlg = await A.rawInvoke('dialog:open-file', {});
    assert.ok(dlg.result && dlg.result.success === false, `dialog:open-file: ${JSON.stringify(dlg)}`);
    const none = await A.rawInvoke('no:existe');
    assert.ok(/No handler registered/.test(none.error || ''), `canal inexistente: ${JSON.stringify(none)}`);
    assert.strictEqual(A.child.exitCode, null, 'el proceso Node murio');
    assert.deepStrictEqual(await api.store.getHosts(), [], 'Node dejo de contestar tras los fallos');
  });

  await check('M4 ssh por el puente: aviso de clave de host, aceptar, `echo mobile-ok`, lotes de ssh:data, close al final', async () => {
    const prompts = [];
    let out = '';
    const order = [];
    const lp = api.ssh.onHostKeyPrompt((p) => { prompts.push(p); api.ssh.respondHostKey(p.requestId, true); });
    api.ssh.onData((sid, data) => { out += data; order.push('data'); });
    api.ssh.onClose(() => order.push('close'));
    try {
      const { sessionId } = await api.ssh.connect({ host: '127.0.0.1', port: sshd.port, username: 'termilab', password: 'mobile', label: 'sshd local' });
      assert.ok(sessionId, 'sin sessionId');
      assert.strictEqual(prompts.length, 1, `avisos de clave: ${prompts.length}`);
      assert.strictEqual(prompts[0].reason, 'unknown');
      assert.ok(/^SHA256:/.test(prompts[0].fingerprint), 'el aviso no trae huella');
      await waitFor('el prompt del shell', () => out.includes('$ '));
      api.ssh.sendData(sessionId, 'echo mobile-ok\r');
      await waitFor('la salida de echo', () => /\r\nmobile-ok\r\n/.test(out));

      const before = A.stats.received.filter(([e, p]) => e === 'ipc:event' && p.channel === 'ssh:data').length;
      api.ssh.sendData(sessionId, 'burst 400\r');
      await waitFor('burst-done', () => out.includes('burst-done'));
      const msgs = A.stats.received.filter(([e, p]) => e === 'ipc:event' && p.channel === 'ssh:data').length - before;
      assert.ok((out.match(/\.{400}/) || []).length === 1, 'los 400 bytes del burst no llegaron enteros y en orden');
      assert.ok(msgs <= 40, `400 paquetes llegaron en ${msgs} mensajes del puente: no hay lotes`);

      const counts = () => A.stats.received.filter(([e]) => e === 'native:sessions').map(([, p]) => p.count);
      assert.deepStrictEqual(counts(), [1], `native:sessions tras conectar: ${JSON.stringify(counts())}`);

      api.ssh.sendData(sessionId, 'exit\r');
      await waitFor('ssh:close', () => order.includes('close'));
      await waitFor('native:sessions 0 tras el exit remoto', () => counts().join() === '1,0');
      assert.strictEqual(order.lastIndexOf('data') < order.indexOf('close'), true, 'un ssh:data llego despues de ssh:close');
      const kh = await api.knownHosts.list();
      assert.deepStrictEqual(kh.map(e => [e.host, e.port]), [['127.0.0.1', sshd.port]], 'la clave aceptada no se guardo');
      await waitFor('el historial', async () => (await api.logs.list()).some(e => e.endedAt));
      const logs = await api.logs.list();
      assert.strictEqual(logs[0].deviceName, DEVICE_NAME, `historial con deviceName=${logs[0].deviceName}`);
    } finally {
      api.ssh.removeHostKeyPromptListener(lp);
      api.ssh.removeAllListeners();
    }
  });

  // ─── INTEROP escritorio -> movil ──────────────────────────
  await check('M5 INTEROP escritorio->movil: boveda, host con contrasena y clave SSH de escritorio se abren en el movil', async () => {
    const dirD = path.join(tmp, 'escritorio-A');
    await desktopDevice(srvA.url(), {
      action: 'create', userData: dirD, token: 'token-escritorio', passphrase: PASS_A,
      hosts: [{ id: 'host-D', label: 'desde escritorio', hostname: 'd.example', port: 22, username: 'derek', authType: 'password', password: SECRET_D }],
      keys: [{ id: 'key-D', name: 'clave de escritorio', type: 'ed25519', privateKey: PRIV_D }],
    });
    const cable = srvA.allBodies();
    assert.ok(!cable.includes(SECRET_D) && !cable.includes(PRIV_D) && !cable.includes(PASS_A), 'escritorio subio un secreto en claro');
    assert.strictEqual(srvA.rowFor('keys', 'key-D').enc, true);

    srvA.hooks.authorizeUrl = 'https://termilab.example/authorize?code=codigo-arnes';
    await api.sync.login();
    assert.deepStrictEqual(openedUrls, [srvA.hooks.authorizeUrl], 'shell.openExternal no llego a la pagina como native:open-url');
    // El login en curso mantiene el foreground service: con la Custom Tab delante,
    // Android 15+ corta la red de un proceso en cache y /auth/poll muere.
    const ev = A.stats.received.filter(([e]) => e === 'native:sessions').map(([, p]) => p);
    const iLogin = ev.findIndex(p => p.signingIn === true);
    const iUrl = A.stats.received.findIndex(([e]) => e === 'native:open-url');
    const iOn = A.stats.received.findIndex(([e, p]) => e === 'native:sessions' && p.signingIn === true);
    assert.ok(iLogin >= 0, `ningun native:sessions con signingIn durante el login: ${JSON.stringify(ev)}`);
    assert.ok(iOn < iUrl, 'signingIn llego despues de abrir la URL: el servicio arrancaria ya en segundo plano');
    assert.strictEqual(ev[ev.length - 1].signingIn, false, 'signingIn no volvio a false al terminar el login');
    await api.sync.syncNow();
    let st = await api.sync.status();
    assert.strictEqual(st.signedIn, true);
    assert.strictEqual(st.vaultExists, true, 'el movil no vio la boveda de escritorio');
    assert.strictEqual(st.unlocked, false);
    const sealed = (await api.store.getHosts()).find(h => h.id === 'host-D');
    assert.ok(sealed && sealed.password !== SECRET_D, 'el host llego con la contrasena sin haber desbloqueado');

    await api.sync.unlock(PASS_A);
    await api.sync.syncNow();
    st = await api.sync.status();
    assert.strictEqual(st.unlocked, true, 'el passphrase de escritorio no desbloqueo el movil');
    const host = (await api.store.getHosts()).find(h => h.id === 'host-D');
    assert.strictEqual(host && host.password, SECRET_D, 'la contrasena del host no se descifro en el movil');
    const keys = readJson(path.join(dirA, 'data', 'keys.json'));
    assert.strictEqual((keys.find(k => k.id === 'key-D') || {}).privateKey, PRIV_D, 'la clave SSH no se descifro en el movil');
  });

  await check('M6 DSK por env: token y clave maestra en reposo en AES-256-GCM con esa clave; sin archivo de respaldo', () => {
    const file = path.join(dirA, 'data', 'sync-secrets.json');
    const raw = fs.readFileSync(file, 'utf-8');
    assert.ok(!raw.includes('token-login'), 'el token esta en claro en sync-secrets.json');
    const s = JSON.parse(raw);
    const sealedValues = Object.values(s).filter(v => typeof v === 'string' && v.length > 40);
    assert.ok(sealedValues.length >= 2, `esperaba token y clave maestra sellados, hay ${sealedValues.length}`);
    const opened = sealedValues.map(v => unsealWithDsk(dskA, v));
    assert.ok(opened.includes('token-login'), 'ningun valor sellado se abre con la DSK como el token');
    assert.ok(!fs.existsSync(path.join(dirA, 'device-key.json')), 'con TERMILAB_DSK no debe escribirse device-key.json');
  });
  await A.stop();

  // ─── Movil B -> escritorio ────────────────────────────────
  const dirB = path.join(tmp, 'movil-B');
  const dskB = crypto.randomBytes(32).toString('base64');
  const B = spawnMobile(bundle, { name: 'movil-B', dataDir: dirB, syncUrl: srvB.url(), dsk: dskB });
  const apiB = shimMod.createElectronAPI(B.transport, {});
  let privB = null;
  await check('M7 INTEROP movil->escritorio: boveda, host y clave generada en el movil se abren en escritorio', async () => {
    await apiB.sync.login();
    await apiB.store.saveHost({ id: 'host-M', label: 'desde el movil', hostname: 'm.example', port: 22, username: 'derek', authType: 'password', password: SECRET_M });
    const { key } = await apiB.store.generateKey({ name: 'clave del movil', type: 'ed25519' });
    assert.ok(key && key.id, 'generateKey no devolvio la clave');
    assert.ok(String(key.publicKey || '').endsWith(`termilab@${DEVICE_NAME}`), `comentario de la publica: ${key.publicKey}`);
    const r = await apiB.sync.setupPassphrase(PASS_B);
    assert.deepStrictEqual(r, { unlocked: true, synced: true });
    privB = readJson(path.join(dirB, 'data', 'keys.json')).find(k => k.id === key.id).privateKey;
    const cable = srvB.allBodies();
    assert.ok(!cable.includes(SECRET_M) && !cable.includes(privB.split('\n')[1]) && !cable.includes(PASS_B), 'el movil subio un secreto en claro');

    const d = await desktopDevice(srvB.url(), { action: 'open', userData: path.join(tmp, 'escritorio-B'), token: 'token-escritorio-B', passphrase: PASS_B });
    assert.strictEqual(d.status.unlocked, true, 'el passphrase del movil no desbloqueo escritorio');
    assert.strictEqual((d.hosts.find(h => h.id === 'host-M') || {}).password, SECRET_M, 'escritorio no descifro la contrasena del host');
    assert.strictEqual((d.keys.find(k => k.id === key.id) || {}).privateKey, privB, 'escritorio no descifro la clave generada en el movil');
    assert.ok(!fs.existsSync(path.join(dirB, 'device-key.json')), 'se creo device-key.json: la DSK ya no vive en un archivo');
  });
  await B.stop();

  // ─── Segundo arranque de B: la misma DSK por env + cola ───
  const B2 = spawnMobile(bundle, { name: 'movil-B2', dataDir: dirB, syncUrl: srvB.url(), dsk: dskB });
  await check('M8 segundo arranque con la misma DSK: sigue con sesion y desbloqueado', async () => {
    await B2.ready;
    // La app vuelve a primer plano ANTES de que la pagina salude: el sync que
    // dispara emite sync:status, y eso tiene que esperar en la cola de Node.
    const pulls = () => srvB.requests.filter(r => r.method === 'GET' && r.path === '/v1/sync').length;
    const before = pulls();
    B2.resume();
    await waitFor('que el sync del resume llegue al servidor', () => pulls() > before, 8000);
    await sleep(300);
    const statuses = [];
    const apiB2 = shimMod.createElectronAPI(B2.transport, {});
    apiB2.sync.onStatus(s => statuses.push(s));
    await waitFor('el sync:status encolado', () => statuses.length > 0, 5000);
    assert.deepStrictEqual(B2.stats.dropped, [], `mensajes perdidos antes del hello: ${B2.stats.dropped.join(', ')}`);
    assert.ok(statuses.some(s => s.signedIn && s.unlocked), `el estado tras reiniciar no esta con sesion y desbloqueado: ${JSON.stringify(statuses[statuses.length - 1])}`);
    const host = (await apiB2.store.getHosts()).find(h => h.id === 'host-M');
    assert.strictEqual(host && host.password, SECRET_M);
  });
  await B2.stop();

  // ─── Un device-key.json de fase 1 no manda ────────────────
  // Java lo migra y lo borra antes de arrancar Node; si alguno sobrevive,
  // Node no lo lee ni lo reescribe: la DSK es la del env.
  const legacyFile = path.join(dirB, 'device-key.json');
  const legacyBody = JSON.stringify({ key: crypto.randomBytes(32).toString('base64'), note: 'fase 1' });
  fs.writeFileSync(legacyFile, legacyBody);
  const B3 = spawnMobile(bundle, { name: 'movil-B3', dataDir: dirB, syncUrl: srvB.url(), dsk: dskB });
  await check('M9 con un device-key.json viejo en DATADIR, Node usa la DSK del env y no toca el archivo', async () => {
    const apiB3 = shimMod.createElectronAPI(B3.transport, {});
    const st = await apiB3.sync.status();
    assert.ok(st.signedIn && st.unlocked, `con la DSK del env deberia seguir desbloqueado: ${JSON.stringify(st)}`);
    assert.strictEqual(fs.readFileSync(legacyFile, 'utf-8'), legacyBody, 'Node reescribio device-key.json');
    const src = fs.readFileSync(bundle, 'utf-8');
    assert.ok(!src.includes('device-key.json'), 'el bundle de Node todavia menciona device-key.json');
  });
  await B3.stop();
  fs.unlinkSync(legacyFile);

  // ─── DSK nueva: el unwrap fallo (backup restaurado, clave invalidada) ─
  const B4 = spawnMobile(bundle, { name: 'movil-B4', dataDir: dirB, syncUrl: srvB.url(), dsk: crypto.randomBytes(32).toString('base64') });
  await check('M10 DSK nueva: lo sellado no se abre (_unwrap -> null), se vuelve a entrar y la UI pide el passphrase; con el passphrase, todo vuelve', async () => {
    const apiB4 = shimMod.createElectronAPI(B4.transport, {});
    let st = await apiB4.sync.status();
    assert.strictEqual(st.signedIn, false, `el token sellado con la DSK vieja no deberia abrirse: ${JSON.stringify(st)}`);
    assert.strictEqual(B4.child.exitCode, null, 'Node murio con secretos ilegibles');
    await apiB4.sync.login();
    await apiB4.sync.syncNow();
    st = await apiB4.sync.status();
    // PassphraseCard (modo desbloquear) sale con signedIn && vaultExists && !unlocked
    assert.ok(st.signedIn && st.vaultExists && !st.unlocked, `esperaba "hay boveda, bloqueado" (tarjeta de desbloqueo): ${JSON.stringify(st)}`);
    await apiB4.sync.unlock(PASS_B);
    await apiB4.sync.syncNow();
    st = await apiB4.sync.status();
    assert.strictEqual(st.unlocked, true, 'el passphrase no desbloqueo con la DSK nueva');
    const host = (await apiB4.store.getHosts()).find(h => h.id === 'host-M');
    assert.strictEqual(host && host.password, SECRET_M, 'la contrasena del host no volvio tras desbloquear');
  });
  await B4.stop();

  // ─── Sin DSK: sin secretos, y ningun archivo ─────────────
  const dirC = path.join(tmp, 'movil-C');
  const C = spawnMobile(bundle, { name: 'movil-C', dataDir: dirC, syncUrl: srvB.url(), dsk: null });
  await check('M11 sin TERMILAB_DSK: login rechazado limpio, Node vivo, sin device-key.json ni sync-secrets.json', async () => {
    const apiC = shimMod.createElectronAPI(C.transport, {});
    await assert.rejects(apiC.sync.login(), /almacen de claves/);
    assert.deepStrictEqual(await apiC.store.getHosts(), []);
    assert.strictEqual(C.child.exitCode, null);
    assert.ok(!fs.existsSync(path.join(dirC, 'device-key.json')), 'sin DSK se creo device-key.json');
    assert.ok(!fs.existsSync(path.join(dirC, 'data', 'sync-secrets.json')), 'sin DSK se guardaron secretos');
  });
  await C.stop();

  // ─── El "Cancel" de un login a medias (Android, fase 4) ───
  const srvD = fakeServer();
  srvD.hooks.pollPending = true;
  await srvD.listen();
  const dirD = path.join(tmp, 'movil-D');
  const D = spawnMobile(bundle, { name: 'movil-D', dataDir: dirD, syncUrl: srvD.url(), dsk: crypto.randomBytes(32).toString('base64') });
  await check('M12 cancelar un login a medias: logout() corta el sondeo, el login rechaza y signingIn vuelve a false', async () => {
    const apiD = shimMod.createElectronAPI(D.transport, { onOpenUrl: () => {} });
    const polls = () => srvD.requests.filter(r => r.path === '/auth/poll').length;
    const signing = () => D.stats.received.filter(([e]) => e === 'native:sessions').map(([, p]) => p.signingIn);
    const login = apiD.sync.login();
    const outcome = login.then(() => 'resolvio', err => err.message);
    await waitFor('dos sondeos en 202', () => polls() >= 2, 8000);
    assert.strictEqual(signing().slice(-1)[0], true, `signingIn durante el login: ${JSON.stringify(signing())}`);
    await apiD.sync.logout();
    assert.match(await outcome, /cancelado/, 'el login no se cancelo');
    await waitFor('signingIn false tras cancelar', () => signing().slice(-1)[0] === false);
    const after = polls();
    await sleep(4500);   // dos intervalos de sondeo
    assert.strictEqual(polls(), after, `siguio sondeando tras cancelar (${after} -> ${polls()})`);
    assert.strictEqual((await apiD.sync.status()).signedIn, false);
  });
  await D.stop();
  await srvD.close();

  await check('M13 teclas extra: secuencias xterm, cursor de aplicacion y Ctrl/Alt pegajosos', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'components', 'Terminal', 'mobile', 'keys.js'), 'utf-8');
    const k = await import(`data:text/javascript,${encodeURIComponent(src)}`);
    const seq = (id, o) => k.keySequence(id, o);
    assert.strictEqual(seq('up'), '\x1b[A');
    assert.strictEqual(seq('up', { appCursor: true }), '\x1bOA');
    assert.strictEqual(seq('left', { ctrl: true }), '\x1b[1;5D');
    assert.strictEqual(seq('home', { appCursor: true }), '\x1bOH');
    assert.strictEqual(seq('pgdn'), '\x1b[6~');
    assert.strictEqual(seq('esc'), '\x1b');
    assert.strictEqual(seq('tab'), '\t');
    assert.strictEqual(seq('|'), '|');
    assert.deepStrictEqual(k.applyModifiers('c', { ctrl: true }), { data: '\x03', used: true });
    assert.deepStrictEqual(k.applyModifiers('C', { ctrl: true }), { data: '\x03', used: true });
    assert.deepStrictEqual(k.applyModifiers('x', { alt: true }), { data: '\x1bx', used: true });
    assert.deepStrictEqual(k.applyModifiers('ls', { ctrl: true }), { data: 'ls', used: false }, 'un pegado no se modifica');
    assert.strictEqual(k.tapModifier('off', 0, 1000), 'once');
    assert.strictEqual(k.tapModifier('once', 1000, 1200), 'locked', 'doble toque = bloqueado');
    assert.strictEqual(k.tapModifier('once', 1000, 2000), 'off', 'segundo toque lento = apagado');
    assert.strictEqual(k.tapModifier('locked', 0, 5000), 'off');
    assert.strictEqual(k.afterUse('once'), 'off');
    assert.strictEqual(k.afterUse('locked'), 'locked');
  });

  await sshd.close();
  await srvA.close();
  await srvB.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  if (failures || process.env.VERBOSE) {
    for (const [name, log] of childLogs) {
      const text = log.join('').trim();
      if (text) console.log(`\n--- salida de ${name} ---\n${text.split('\n').slice(-40).join('\n')}`);
    }
  }
  console.log(results.join('\n'));
  const total = results.length;
  console.log(failures ? `\n${failures} de ${total} comprobacion(es) fallidas` : `\nTodo en verde (${total} comprobaciones, Node ${process.version})`);
  process.exit(failures ? 1 : 0);
}

main().catch(err => {
  console.error(results.join('\n'));
  for (const [name, log] of childLogs) console.error(`\n--- salida de ${name} ---\n${log.join('').trim().split('\n').slice(-40).join('\n')}`);
  console.error('\nEl arnes reviento:', err);
  process.exit(1);
});
