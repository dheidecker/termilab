#!/usr/bin/env node
/**
 * Arnes del proceso main. `npm run build` NO valida nada de esto: vite compila
 * electron/main.js con todos los require locales como externos, asi que el
 * bundle sale de 3 kB y los servicios ni se leen.
 *
 *   node scripts/check-main.js
 *
 * Que hace:
 *  1. `node --check` sobre todo electron/**.js (sintaxis).
 *  2. Carga el grafo COMPLETO con `electron` stubeado (require a un archivo
 *     borrado, canal IPC que preload llama y nadie registra, etc.).
 *  3. Levanta un servidor de sync falso en localhost y ejecuta sincronizaciones
 *     de verdad contra el, con userData en un mkdtemp. Comprueba sobre todo el
 *     CIFRADO POR CAMPO: que la contrasena de un host no aparece en claro en
 *     ningun byte del cuerpo que sale hacia el servidor.
 *  4. El EMPAREJAMIENTO EN DOS PASOS completo (/accept y luego /complete),
 *     mirando los cuerpos que salen: ningun material cifrado puede viajar
 *     antes de que el usuario confirme los seis digitos.
 *  5. La BOVEDA: clave maestra derivada del passphrase de la cuenta, con
 *     varios dispositivos simulados en el mismo proceso (cada uno con su
 *     userData, su llavero y su almacen; ver `usarDispositivo`).
 *
 * No abre Electron ni toca el servidor real. No necesita red.
 */

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const http = require('http');
const Module = require('module');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SECRET = 'p4ssw0rd-de-Derek-no-debe-salir';
const PASSPHRASE = 'frase-de-la-clave-privada';
// Passphrases de BOVEDA (los de la cuenta). T8 comprueba que ninguno aparece en
// consola, en lo que se manda al renderer, en disco ni en el cable.
const PASS_CUENTA = 'caballo-bateria-grapa-correcta';
const PASS_T1 = 'la-misma-frase-en-los-dos-equipos';
const PASS_T4 = 'frase-para-migrar-lo-legacy';
const PASS_MAL = 'esta-no-es-la-frase-buena';
const PASS_G = 'frase-del-que-pierde-la-carrera';
const PASS_H = 'frase-del-que-gana-la-carrera';
const PASSPHRASES_BOVEDA = [PASS_CUENTA, PASS_T1, PASS_T4, PASS_MAL, PASS_G, PASS_H];
const clavesDerivadas = [];   // para T8: tampoco pueden salir

// Todo lo que el proceso escribe por consola, para T8. Se sigue imprimiendo.
const consola = [];
for (const metodo of ['log', 'error', 'warn', 'info', 'debug']) {
  const real = console[metodo].bind(console);
  console[metodo] = (...args) => {
    consola.push(args.map(a => {
      if (a instanceof Error) return `${a.message}\n${a.stack}`;
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch (_) { return String(a); }
    }).join(' '));
    real(...args);
  };
}
const alRenderer = [];        // todo lo que main manda por webContents.send
const cableTotal = [];        // todo cuerpo que recibe cualquier servidor falso (no se resetea)

let failures = 0;
const results = [];

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { results.push(`  ok   ${name}`); })
    .catch(err => {
      failures++;
      results.push(`  FALLA ${name}\n         ${err && err.message}`);
    });
}

// ─── 1. Sintaxis ────────────────────────────────────────────

function electronFiles() {
  const out = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) out.push(full);
    }
  };
  walk(path.join(ROOT, 'electron'));
  return out;
}

// ─── 2. Stub de electron ────────────────────────────────────

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'termilab-arnes-'));
// Mutable: `usarDispositivo` cambia de equipo simulado cambiando esto.
let currentUserData = userData;
const handlers = new Map();      // canal -> handler registrado por ipc-handlers
let bridge = null;               // lo que preload expone como window.electronAPI

// Listeners que preload engancha con ipcRenderer.on, para poder comprobar que
// cada suscriptor desengancha el suyo y no los de los demas.
const rendererListeners = new Map();
const emit = (channel, data) => {
  for (const listener of (rendererListeners.get(channel) || []).slice()) listener({}, data);
};

const electronStub = {
  app: {
    getPath: () => currentUserData,
    getVersion: () => '0.0.0-test',
    getName: () => 'Termilab',
    on: () => {},
    whenReady: () => Promise.resolve(),
    quit: () => {},
  },
  // Cifrado falso a proposito: aqui se prueba el cableado, no la criptografia
  // del sistema operativo.
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`fake:${value}`, 'utf-8'),
    decryptString: buf => buf.toString('utf-8').replace(/^fake:/, ''),
  },
  ipcMain: {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: () => {},
    removeHandler: channel => handlers.delete(channel),
  },
  ipcRenderer: {
    invoke: (channel, ...args) => {
      const fn = handlers.get(channel);
      if (!fn) return Promise.reject(new Error(`canal sin registrar: ${channel}`));
      return Promise.resolve(fn({}, ...args));
    },
    on: (channel, listener) => {
      if (!rendererListeners.has(channel)) rendererListeners.set(channel, []);
      rendererListeners.get(channel).push(listener);
    },
    removeListener: (channel, listener) => {
      const list = rendererListeners.get(channel) || [];
      const i = list.indexOf(listener);
      if (i >= 0) list.splice(i, 1);
    },
    removeAllListeners: (channel) => { rendererListeners.set(channel, []); },
    send: () => {},
  },
  contextBridge: {
    exposeInMainWorld: (_name, api) => { bridge = api; },
  },
  shell: { openExternal: () => Promise.resolve() },
  dialog: { showOpenDialog: () => Promise.resolve({ canceled: true }) },
  BrowserWindow: class {
    constructor() {
      this.webContents = { send: (channel, data) => { alRenderer.push(JSON.stringify([channel, data])); }, on: () => {}, setWindowOpenHandler: () => {}, session: { on: () => {} } };
    }
    on() { return this; }
    once() { return this; }
    isDestroyed() { return false; }
    loadURL() { return Promise.resolve(); }
    loadFile() { return Promise.resolve(); }
    show() {}
  },
  nativeTheme: { on: () => {} },
  Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => ({}) },
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  if (request === 'electron-updater') return { autoUpdater: { on: () => {}, checkForUpdates: () => Promise.resolve(null) } };
  return realLoad.call(this, request, parent, isMain);
};

// ─── 3. Servidor de sync falso ──────────────────────────────

/** Guarda lo que le suben tal cual y lo devuelve por cursor, como el real. */
function fakeServer() {
  const rows = [];             // { cursor, record }
  const bodies = [];           // TODOS los cuerpos crudos que ha recibido
  const requests = [];         // { method, path, raw } de TODAS las peticiones
  const pairings = new Map();  // id -> { id, pubNew, pubExisting, ciphertext, nonce, state }
  // Un tercero que sustituye claves publicas por el camino.
  const mitm = { pubNew: null, pubExisting: null };
  let cursor = 0;
  let pairSeq = 0;
  // afterVaultPush: simula la carrera de T7. failSyncPost: el servidor se cae
  // justo al subir (T4: migracion interrumpida).
  // failSyncGet: sin red para bajar (T11: emparejar sin poder verificar).
  const hooks = { afterVaultPush: null, failSyncPost: false, failSyncGet: false };

  const store = record => {
    const index = rows.findIndex(
      r => r.record.collection === record.collection && r.record.item_id === record.item_id
    );
    const entry = { cursor: ++cursor, record };
    if (index !== -1) rows.splice(index, 1);
    rows.push(entry);
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (raw) { bodies.push(raw); cableTotal.push(raw); }
      const url = new URL(req.url, 'http://localhost');
      requests.push({ method: req.method, path: url.pathname, raw });
      res.setHeader('content-type', 'application/json');
      const json = (code, data) => { res.statusCode = code; res.end(JSON.stringify(data)); };

      if (req.method === 'POST' && url.pathname === '/v1/sync' && hooks.failSyncPost) {
        return json(503, { error: 'servidor caido a proposito' });
      }
      if (req.method === 'POST' && url.pathname === '/v1/sync') {
        const records = (JSON.parse(raw || '{}').records) || [];
        for (const record of records) {
          if (record.payload !== null && record.ciphertext !== null) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'payload y ciphertext a la vez' }));
            return;
          }
          store(record);
        }
        const conBoveda = records.some(r => r.collection === 'settings' && r.item_id === '__vault__');
        res.end(JSON.stringify({ applied: records.length, cursor }));
        if (conBoveda && hooks.afterVaultPush) hooks.afterVaultPush();
        return;
      }

      // Login por codigo de dispositivo: responde "listo" al primer sondeo.
      if (req.method === 'POST' && url.pathname === '/auth/start') {
        return json(200, { code: 'codigo-arnes', authorize_url: null });
      }
      if (req.method === 'GET' && url.pathname === '/auth/poll') {
        return json(200, { status: 'listo', token: 'token-login', email: 'login@local' });
      }

      if (req.method === 'GET' && url.pathname === '/v1/sync' && hooks.failSyncGet) {
        return json(503, { error: 'sin red a proposito' });
      }
      if (req.method === 'GET' && url.pathname === '/v1/sync') {
        const since = Number(url.searchParams.get('since') || 0);
        const pending = rows.filter(r => r.cursor > since).sort((a, b) => a.cursor - b.cursor);
        res.end(JSON.stringify({
          records: pending.map(r => r.record),
          cursor: pending.length ? pending[pending.length - 1].cursor : since,
          has_more: false,
        }));
        return;
      }

      // ── Emparejamiento en DOS pasos, como el servidor real ──
      // /accept recibe SOLO la publica; /complete la clave maestra sellada y
      // responde 409 si no hubo /accept antes. Juntar los dos pasos es el
      // fallo que este protocolo arregla, asi que aqui se rechaza a proposito.
      if (req.method === 'POST' && url.pathname === '/v1/pair/request') {
        const body = JSON.parse(raw || '{}');
        if (!body.pub) return json(400, { error: 'falta la clave publica' });
        const id = `par-${++pairSeq}`;
        pairings.set(id, { id, pubNew: body.pub, pubExisting: null, ciphertext: null, nonce: null, state: 'pendiente' });
        return json(200, { pairing_id: id });
      }

      if (req.method === 'GET' && url.pathname === '/v1/pair/pending') {
        const pending = [...pairings.values()]
          .filter(p => p.state === 'pendiente')
          .map(p => ({
            id: p.id,
            pub_new: mitm.pubNew || p.pubNew,
            device_name: 'portatil-nuevo',
            platform: 'linux',
            created_at: '2026-01-01T00:00:00.000Z',
            expires_at: '2026-01-01T00:10:00.000Z',
          }));
        return json(200, { pending });
      }

      const pairMatch = url.pathname.match(/^\/v1\/pair\/([^/]+)(?:\/(accept|complete|reject))?$/);
      if (pairMatch) {
        const pairing = pairings.get(decodeURIComponent(pairMatch[1]));
        const action = pairMatch[2];
        if (!pairing) return json(404, { error: 'emparejamiento desconocido' });

        if (req.method === 'POST' && action === 'accept') {
          const body = JSON.parse(raw || '{}');
          if (!body.pub) return json(400, { error: 'falta la clave publica' });
          if ('ciphertext' in body || 'nonce' in body) {
            return json(400, { error: 'el paso 1 no puede llevar material cifrado' });
          }
          if (pairing.state !== 'pendiente') return json(409, { error: 'ese emparejamiento ya no esta pendiente' });
          pairing.pubExisting = body.pub;
          pairing.state = 'verificar';
          return json(200, { status: 'verificar' });
        }

        if (req.method === 'POST' && action === 'complete') {
          const body = JSON.parse(raw || '{}');
          if ('pub' in body) return json(400, { error: 'la publica va en el paso 1, no aqui' });
          if (pairing.state !== 'verificar') {
            return json(409, { error: 'ese emparejamiento no se ha aceptado todavia' });
          }
          if (!body.ciphertext || !body.nonce) return json(400, { error: 'falta el material cifrado' });
          pairing.ciphertext = body.ciphertext;
          pairing.nonce = body.nonce;
          pairing.state = 'listo';
          return json(200, { status: 'listo' });
        }

        if (req.method === 'POST' && action === 'reject') {
          pairing.state = 'rechazado';
          return json(200, { status: 'rechazado' });
        }

        if (req.method === 'GET' && !action) {
          if (pairing.state === 'rechazado') return json(403, { error: 'rechazado' });
          if (pairing.state === 'caducado') return json(410, { error: 'caducado' });
          if (pairing.state === 'pendiente') return json(202, { status: 'pendiente' });
          if (pairing.state === 'verificar') {
            return json(202, { status: 'verificar', pub_existing: mitm.pubExisting || pairing.pubExisting });
          }
          return json(200, {
            status: 'listo',
            pub_existing: mitm.pubExisting || pairing.pubExisting,
            ciphertext: pairing.ciphertext,
            nonce: pairing.nonce,
          });
        }
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'no existe' }));
    });
  });

  return {
    server,
    rows,
    bodies,
    listen: () => new Promise(resolve => server.listen(0, '127.0.0.1', resolve)),
    url: () => `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)),
    rowFor: (collection, itemId) => {
      const found = rows.filter(r => r.record.collection === collection && r.record.item_id === itemId);
      return found.length ? found[found.length - 1].record : null;
    },
    /** El cuerpo entero que ha viajado, para buscar cadenas en claro. */
    allBodies: () => bodies.join('\n'),
    /** Mete una fila como si la hubiera subido otro dispositivo (o una version vieja). */
    inject: record => store(record),
    hooks,
    /** Cuerpos de POST /v1/sync desde el ultimo reset. */
    syncPosts: () => requests.filter(r => r.method === 'POST' && r.path === '/v1/sync').map(r => r.raw),
    reset: () => { bodies.length = 0; requests.length = 0; },
    mitm,
    requests,
    pairRequests: () => requests.filter(r => r.path.startsWith('/v1/pair/')),
    /** Peticiones cuyo CUERPO lleva material cifrado, miradas desde fuera. */
    requestsConCifrado: () => requests.filter(r => {
      if (!r.raw) return false;
      let body;
      try { body = JSON.parse(r.raw); } catch (_) { return /ciphertext/.test(r.raw); }
      return !!(body && typeof body === 'object' && (body.ciphertext || body.nonce));
    }),
    pairing: id => pairings.get(id) || null,
    /** El servidor pierde el paso 1 (reinicio, caducidad): el /complete dara 409. */
    olvidaAceptacion: id => {
      const pairing = pairings.get(id);
      pairing.state = 'pendiente';
      pairing.pubExisting = null;
    },
    resetPairings: () => { pairings.clear(); mitm.pubNew = null; mitm.pubExisting = null; },
  };
}

// ─── 4. Escenarios ──────────────────────────────────────────

async function main() {
  // 1) sintaxis
  await check('sintaxis de electron/**/*.js', () => {
    for (const file of electronFiles()) {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    }
  });

  // 2) grafo completo + contrato IPC
  let ipcHandlers;
  await check('carga del grafo completo (ipc-handlers + servicios)', () => {
    ipcHandlers = require(path.join(ROOT, 'electron', 'ipc-handlers.js'));
    if (typeof ipcHandlers.registerIpcHandlers === 'function') {
      ipcHandlers.registerIpcHandlers(new electronStub.BrowserWindow());
    } else if (typeof ipcHandlers === 'function') {
      ipcHandlers(new electronStub.BrowserWindow());
    }
    assert.ok(handlers.size > 0, 'ipc-handlers no registro ningun canal');
  });

  await check('preload no llama a ningun canal sin registrar', () => {
    require(path.join(ROOT, 'electron', 'preload.js'));
    assert.ok(bridge, 'preload no expuso nada en el contextBridge');
    const missing = [];
    const walk = (obj, prefix) => {
      for (const [key, value] of Object.entries(obj || {})) {
        if (value && typeof value === 'object') walk(value, `${prefix}${key}.`);
      }
    };
    walk(bridge, '');
    // Los canales que preload usa se descubren leyendo el fuente: es la unica
    // forma sin invocar cada funcion (algunas abren navegadores).
    const src = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf-8');
    for (const m of src.matchAll(/invoke\(\s*'([^']+)'/g)) {
      // updater:* los registra main.js (stubs en dev), no ipc-handlers.
      if (m[1].startsWith('updater:')) continue;
      if (!handlers.has(m[1])) missing.push(m[1]);
    }
    assert.deepStrictEqual(missing, [], `canales sin handler: ${missing.join(', ')}`);
  });

  await check('cada suscriptor a *:status desengancha solo el suyo', () => {
    // Dos componentes escuchan updater:status (UpdateNotification y Settings).
    // Con removeAllListeners, cerrar Settings dejaba sordo al cartel de
    // actualizacion hasta reiniciar la app. onStatus devuelve su listener y
    // removeStatusListener(listener) quita solo ese.
    for (const domain of ['updater', 'sync']) {
      const chan = `${domain}:status`;
      const api = bridge[domain];
      const a = [], b = [];
      const lA = api.onStatus(d => a.push(d));
      const lB = api.onStatus(d => b.push(d));
      assert.strictEqual(typeof lA, 'function', `${chan}: onStatus no devolvio el listener`);
      assert.notStrictEqual(lA, lB, `${chan}: devolvio el mismo listener dos veces`);

      emit(chan, 1);
      assert.deepStrictEqual([a.length, b.length], [1, 1], `${chan}: no recibieron los dos`);

      api.removeStatusListener(lB);
      emit(chan, 2);
      assert.deepStrictEqual([a.length, b.length], [2, 1],
        `${chan}: al irse un suscriptor, el otro dejo de recibir`);

      api.removeStatusListener();   // sin argumento: limpia todo (compatibilidad)
      emit(chan, 3);
      assert.strictEqual(a.length, 2, `${chan}: sin argumento no limpio`);
    }
  });

  const cryptoService = require(path.join(ROOT, 'electron', 'services', 'crypto-service.js'));
  const storeService = require(path.join(ROOT, 'electron', 'services', 'store-service.js'));
  const syncService = require(path.join(ROOT, 'electron', 'services', 'sync-service.js'));

  const api = fakeServer();
  await api.listen();
  process.env.TERMILAB_SYNC_URL = api.url();
  await cryptoService.setToken('token-de-prueba');

  // Estado limpio de sincronizacion, como un dispositivo recien logueado.
  const resetSync = async () => {
    syncService.state = { cursor: 0, lastSyncAt: null, email: 'test@local', deviceName: 'arnes', shadow: {} };
    syncService._loaded = true;
    syncService._chain = null;
    await syncService._save();
  };

  const hostConPassword = {
    id: 'host-1',
    label: 'Titan',
    host: '10.0.0.9',
    port: 22,
    username: 'derek',
    authType: 'password',
    password: SECRET,
    group: 'produccion',
    tags: ['linux'],
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const hostConClave = {
    id: 'host-2',
    label: 'Backup',
    host: '10.0.0.10',
    port: 22,
    username: 'root',
    authType: 'key',
    keyId: 'key-1',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  // ── A. La contrasena no sale en claro ─────────────────────
  // La clave sale del passphrase de la cuenta: una clave suelta (sin boveda que
  // la verifique) ya no sella nada, asi que el escenario empieza creando la
  // boveda. setupPassphrase hace el primer sync.
  await storeService.writeRaw('hosts', [hostConPassword, hostConClave]);
  await resetSync();
  api.reset();
  await syncService.setupPassphrase(PASS_CUENTA);
  const CLAVE_CUENTA = await cryptoService.getMasterKey();
  const SAL_CUENTA = await cryptoService.getVaultSalt();
  clavesDerivadas.push(CLAVE_CUENTA);

  await check('el cuerpo subido no contiene la contrasena en claro', () => {
    const body = api.allBodies();
    assert.ok(body.length > 0, 'no se subio nada');
    assert.ok(!body.includes(SECRET), 'LA CONTRASENA VIAJA EN CLARO');
  });

  await check('la fila del host sigue siendo enc:false con el sobre dentro del payload', () => {
    const record = api.rowFor('hosts', 'host-1');
    assert.ok(record, 'no se subio el host');
    assert.strictEqual(record.enc, false);
    assert.strictEqual(record.ciphertext, null);
    assert.strictEqual(record.nonce, null);
    assert.strictEqual(typeof record.payload, 'object');
    assert.strictEqual(record.payload.enc, undefined);
    const sobre = record.payload.password;
    assert.strictEqual(typeof sobre, 'object', 'password deberia ser un sobre');
    assert.ok(sobre.ciphertext && sobre.nonce, 'sobre sin ciphertext/nonce');
  });

  await check('los campos publicos del host siguen legibles', () => {
    const payload = api.rowFor('hosts', 'host-1').payload;
    assert.strictEqual(payload.label, 'Titan');
    assert.strictEqual(payload.host, '10.0.0.9');
    assert.strictEqual(payload.username, 'derek');
    assert.strictEqual(payload.group, 'produccion');
  });

  await check('un host sin contrasena no gana campos vacios', () => {
    const payload = api.rowFor('hosts', 'host-2').payload;
    assert.ok(!('password' in payload), 'aparecio un password vacio');
    assert.ok(!('passphrase' in payload), 'aparecio un passphrase vacio');
    assert.deepStrictEqual(payload, { ...hostConClave });
  });

  // ── B. Ida y vuelta ───────────────────────────────────────
  await storeService.writeRaw('hosts', []);
  await resetSync();
  await syncService.syncNow();

  await check('ida y vuelta: la contrasena vuelve intacta', async () => {
    const hosts = await storeService.readRaw('hosts');
    const host = hosts.find(h => h.id === 'host-1');
    assert.ok(host, 'el host no bajo del servidor');
    assert.strictEqual(host.password, SECRET);
    assert.strictEqual(host.label, 'Titan');
  });

  await check('ida y vuelta: el host por clave baja identico', async () => {
    const hosts = await storeService.readRaw('hosts');
    const host = hosts.find(h => h.id === 'host-2');
    assert.deepStrictEqual(host, { ...hostConClave });
  });

  // passphrase tambien va sellada
  await check('passphrase se sella igual que password', async () => {
    const conFrase = { ...hostConPassword, id: 'host-3', password: '', passphrase: PASSPHRASE };
    await storeService.writeRaw('hosts', [conFrase]);
    await resetSync();
    api.reset();
    await syncService.syncNow();
    assert.ok(!api.allBodies().includes(PASSPHRASE), 'LA PASSPHRASE VIAJA EN CLARO');
    const payload = api.rowFor('hosts', 'host-3').payload;
    assert.strictEqual(typeof payload.passphrase, 'object');
    assert.strictEqual(payload.password, '', 'un campo vacio no se sella, se deja tal cual');
  });

  // ── C. Sin clave maestra ──────────────────────────────────
  await cryptoService.clearAll();
  await cryptoService.setToken('token-de-prueba');
  assert.strictEqual(await cryptoService.hasMasterKey(), false);

  const localSinEmparejar = { ...hostConPassword, id: 'host-4', password: 'local-solo-mia' };
  await storeService.writeRaw('hosts', [localSinEmparejar]);
  await resetSync();
  api.reset();
  await syncService.syncNow();

  await check('sin clave maestra no sube ningun secreto', () => {
    const body = api.allBodies();
    assert.ok(!body.includes('local-solo-mia'), 'SUBIO LA CONTRASENA SIN CLAVE MAESTRA');
    const payload = api.rowFor('hosts', 'host-4').payload;
    assert.ok(!('password' in payload), 'el campo secreto deberia omitirse entero');
    assert.strictEqual(payload.label, 'Titan', 'los campos publicos si deben subir');
  });

  await check('sin clave maestra el estado lo dice', async () => {
    const status = await syncService.status();
    assert.ok(status.secretsWithheld > 0, 'secretsWithheld deberia contar el campo omitido');
    assert.deepStrictEqual([status.vaultExists, status.unlocked], [true, false]);
    // "Bloqueado" lo dicen los campos; `error` es solo para fallos de verdad.
    assert.strictEqual(status.error, null, `estar bloqueado no es un error: ${status.error}`);
  });

  await check('sin clave maestra el host local no pierde su contrasena al bajar', async () => {
    // El servidor tiene host-1 con sobre (ilegible aqui) y host-4 sin secreto.
    // Ninguna de las dos cosas puede borrar lo que este equipo ya tenia.
    syncService.state.cursor = 0;
    syncService.state.shadow = {};
    await syncService.syncNow();
    const hosts = await storeService.readRaw('hosts');
    const local = hosts.find(h => h.id === 'host-4');
    assert.strictEqual(local.password, 'local-solo-mia', 'se machaco la contrasena local');
    const ajeno = hosts.find(h => h.id === 'host-1');
    assert.ok(ajeno, 'el host del servidor deberia verse igualmente');
    assert.strictEqual(ajeno.label, 'Titan', 'sin clave maestra la lista sigue siendo visible');
    assert.ok(!('password' in ajeno), 'no deberia quedar un sobre ilegible en disco');
  });

  await check('al desbloquear despues, el secreto pendiente si sube', async () => {
    api.reset();
    await syncService.unlock(PASS_CUENTA);
    const payload = api.rowFor('hosts', 'host-4').payload;
    assert.strictEqual(typeof payload.password, 'object', 'no reenvio el secreto tras desbloquear');
    assert.ok(!api.allBodies().includes('local-solo-mia'), 'y aun asi nunca en claro');
  });

  // ── D. Instalacion antigua: la sombra dice "limpio" pero el servidor
  //       guarda la contrasena en claro de la epoca anterior ─────────────
  await check('una sombra de la epoca en claro fuerza el reenvio sellado', async () => {
    const viejo = { ...hostConPassword, id: 'host-5', password: 'la-que-ya-se-filtro' };
    await storeService.writeRaw('hosts', [viejo]);
    // Estado tal cual lo dejaria la version anterior: sin secretsVersion y con
    // el hash del host ya "subido".
    const statePath = syncService._statePath();
    syncService.state = {
      cursor: 0, lastSyncAt: null, email: 'test@local', deviceName: 'arnes',
      shadow: { hosts: { 'host-5': { hash: 'da-igual', updated_at: viejo.updatedAt } } },
    };
    await syncService._save();
    // Recolocamos el hash real para que el item parezca limpio.
    const raw = JSON.parse(await fsp.readFile(statePath, 'utf-8'));
    delete raw.secretsVersion;
    await fsp.writeFile(statePath, JSON.stringify(raw), 'utf-8');
    syncService._loaded = false;
    await syncService._load();
    // Tras el _load la entrada debe estar marcada como pendiente.
    assert.strictEqual(syncService.state.shadow.hosts['host-5'].secretsPending, true);
    api.reset();
    await syncService.syncNow();
    const payload = api.rowFor('hosts', 'host-5').payload;
    assert.strictEqual(typeof payload.password, 'object', 'no se reenvio sellada');
    assert.ok(!api.allBodies().includes('la-que-ya-se-filtro'));
  });

  // ── E. Emparejamiento en dos pasos ────────────────────────
  //
  // El mismo proceso hace los dos papeles: `_claims` (el que pide) y
  // `_approvals` (el que aprueba) son mapas distintos y no se rozan. Lo unico
  // compartido es el llavero, asi que para comprobar que la clave maestra
  // llega de verdad se borra antes de reclamarla.
  //
  // Los sondeos se disparan a mano con `_fetchClaim` en vez de esperar al
  // temporizador de 2 s: es la misma funcion que usa `_pollClaim`.
  const pairingCrypto = require(path.join(ROOT, 'electron', 'services', 'pairing-crypto.js'));
  // La clave que se comparte es la de la cuenta: el que la recibe la verifica
  // contra la boveda y rechazaria cualquier otra (ver T5).
  const MASTER = CLAVE_CUENTA;

  const nuevoEscenario = async () => {
    syncService._claims.clear();
    syncService._approvals.clear();
    api.resetPairings();
    api.reset();
    await cryptoService.clearAll();
    await cryptoService.setToken('token-de-prueba');
    await cryptoService.setMasterKey(MASTER, { vaultSalt: SAL_CUENTA });
  };

  const flujo = {};
  await nuevoEscenario();

  await check('paso 1: aceptar manda SOLO la clave publica', async () => {
    const pedido = await syncService.pairingRequest();
    flujo.id = pedido.pairingId;
    assert.ok(flujo.id, 'el servidor no devolvio pairing_id');
    assert.strictEqual(pedido.digits, null, 'no puede haber digitos al pedir: falta la otra publica');

    const { pending } = await syncService.pairingPending();
    const entrada = pending.find(e => e.id === flujo.id);
    assert.ok(entrada, 'el emparejamiento no sale como pendiente en el otro lado');
    assert.strictEqual(entrada.state, 'pendiente');
    assert.ok(/^\d{6}$/.test(entrada.digits || ''), `digitos raros: ${entrada.digits}`);
    flujo.digitsAprueba = entrada.digits;

    const aceptado = await syncService.pairingApprove(flujo.id);
    assert.strictEqual(aceptado.state, 'aceptado');
    assert.strictEqual(aceptado.digits, flujo.digitsAprueba, 'los digitos cambiaron al aceptar');

    const accept = api.pairRequests().filter(r => r.path.endsWith('/accept'));
    assert.strictEqual(accept.length, 1, 'deberia haber exactamente un /accept');
    assert.deepStrictEqual(Object.keys(JSON.parse(accept[0].raw)).sort(), ['pub'],
      'el paso 1 lleva algo mas que la clave publica');
    assert.strictEqual(api.pairRequests().filter(r => r.path.endsWith('/complete')).length, 0,
      'se llamo a /complete en el paso 1');
  });

  await check('el que pide pasa a "verificar" con los MISMOS digitos', async () => {
    await syncService._fetchClaim(flujo.id);
    const status = await syncService.status();
    assert.ok(status.pairing, 'el estado no expone el emparejamiento en curso');
    assert.strictEqual(status.pairing.id, flujo.id);
    assert.strictEqual(status.pairing.state, 'verificar',
      `el que pide deberia poder comparar ya, y esta en ${status.pairing.state}`);
    assert.strictEqual(status.pairing.digits, flujo.digitsAprueba,
      'los dos lados ven digitos distintos con las claves de verdad');
  });

  await check('nada cifrado ha salido antes de que el usuario confirme', () => {
    // Mirado desde fuera: los cuerpos que ha recibido el servidor, no el
    // estado interno del servicio.
    const conCifrado = api.requestsConCifrado();
    assert.deepStrictEqual(conCifrado.map(r => `${r.method} ${r.path}`), [],
      'salio material cifrado antes de confirmar');
    const pairing = api.pairing(flujo.id);
    assert.strictEqual(pairing.ciphertext, null, 'el servidor ya guarda un ciphertext');
    assert.strictEqual(pairing.state, 'verificar');
  });

  await check('confirmar sin haber aceptado no manda nada al servidor', async () => {
    const otro = await syncService.pairingRequest();
    await syncService.pairingPending();
    const antes = api.pairRequests().filter(r => r.path.endsWith('/complete')).length;
    await assert.rejects(
      () => syncService.pairingConfirm(otro.pairingId),
      err => /acept/i.test(err.message),
      'confirmar sin aceptar deberia dar un error que hable de aceptar'
    );
    const despues = api.pairRequests().filter(r => r.path.endsWith('/complete')).length;
    assert.strictEqual(despues, antes, 'se mando un /complete sin haber aceptado');
    syncService._claims.delete(otro.pairingId);
    syncService._approvals.delete(otro.pairingId);
  });

  await check('paso 2: confirmar entrega la clave y llega identica al otro lado', async () => {
    await syncService.pairingConfirm(flujo.id);

    const complete = api.pairRequests().filter(r => r.path.endsWith('/complete'));
    assert.strictEqual(complete.length, 1, 'deberia haber exactamente un /complete');
    assert.deepStrictEqual(Object.keys(JSON.parse(complete[0].raw)).sort(), ['ciphertext', 'nonce'],
      'el paso 2 no debe volver a mandar la publica');

    // A partir de aqui hacemos de dispositivo nuevo: sin clave maestra.
    await cryptoService.clearAll();
    await cryptoService.setToken('token-de-prueba');
    assert.strictEqual(await cryptoService.hasMasterKey(), false);

    await syncService._fetchClaim(flujo.id);
    const status = await syncService.status();
    assert.strictEqual(status.pairing.state, 'listo');

    await syncService.pairingClaim(flujo.id);
    const instalada = await cryptoService.getMasterKey();
    assert.ok(instalada && instalada.equals(MASTER), 'la clave maestra instalada no es la que se envio');
  });

  await check('con una publica sustituida por un tercero, los digitos no cuadran', async () => {
    await nuevoEscenario();
    const pedido = await syncService.pairingRequest();
    // El servidor (o quien este en medio) ensena al que aprueba OTRA publica.
    const atacante = pairingCrypto.generateEphemeralKeyPair();
    api.mitm.pubNew = atacante.pub;
    const { pending } = await syncService.pairingPending();
    const entrada = pending.find(e => e.id === pedido.pairingId);
    await syncService.pairingApprove(pedido.pairingId);
    api.mitm.pubNew = null;

    await syncService._fetchClaim(pedido.pairingId);
    const status = await syncService.status();
    assert.strictEqual(status.pairing.state, 'verificar');
    assert.ok(status.pairing.digits && entrada.digits, 'faltan digitos que comparar');
    assert.notStrictEqual(status.pairing.digits, entrada.digits,
      'LOS DIGITOS COINCIDEN CON UNA PUBLICA SUSTITUIDA: el usuario no podria verlo');
  });

  await check('si la publica del otro cambia a mitad, se corta el emparejamiento', async () => {
    await nuevoEscenario();
    const pedido = await syncService.pairingRequest();
    await syncService.pairingPending();
    await syncService.pairingApprove(pedido.pairingId);
    await syncService._fetchClaim(pedido.pairingId);
    assert.strictEqual((await syncService.status()).pairing.state, 'verificar');

    const atacante = pairingCrypto.generateEphemeralKeyPair();
    api.mitm.pubExisting = atacante.pub;   // cambiazo despues de ensenar los digitos
    // El servicio avisa por consola; aqui el aviso es lo esperado, no ruido.
    const errorReal = console.error;
    console.error = () => {};
    try { await syncService._fetchClaim(pedido.pairingId); } finally { console.error = errorReal; }
    const status = await syncService.status();
    assert.strictEqual(status.pairing.state, 'rejected', 'siguio adelante con otra publica');
    api.mitm.pubExisting = null;
  });

  await check('un 409 al completar se explica y no deja nada a medias', async () => {
    await nuevoEscenario();
    const pedido = await syncService.pairingRequest();
    await syncService.pairingPending();
    const primero = await syncService.pairingApprove(pedido.pairingId);

    // El servidor pierde el paso 1 (reinicio, caducidad, otro lo consumio).
    api.olvidaAceptacion(pedido.pairingId);
    await assert.rejects(
      () => syncService.pairingConfirm(pedido.pairingId),
      err => /acept/i.test(err.message) && !/HTTP 409/.test(err.message),
      'el 409 deberia llegar como frase legible, no como codigo'
    );
    assert.strictEqual(api.pairing(pedido.pairingId).ciphertext, null,
      'el servidor se quedo con material cifrado pese al 409');
    await syncService._fetchClaim(pedido.pairingId);
    assert.strictEqual((await syncService.status()).pairing.state, 'pendiente',
      'el que pide se quedo creyendo que ya habia alguien');

    // Y se puede retomar sin empezar de cero, con los mismos digitos.
    const segundo = await syncService.pairingApprove(pedido.pairingId);
    assert.strictEqual(segundo.digits, primero.digits, 'los digitos cambiaron tras el 409');
    await syncService.pairingConfirm(pedido.pairingId);
    await syncService._fetchClaim(pedido.pairingId);
    assert.strictEqual((await syncService.status()).pairing.state, 'listo');

    await cryptoService.clearAll();
    await cryptoService.setToken('token-de-prueba');
    await syncService.pairingClaim(pedido.pairingId);
    assert.ok((await cryptoService.getMasterKey()).equals(MASTER), 'la clave no llego tras el 409');
  });

  await check('rechazar corta el emparejamiento del otro lado', async () => {
    await nuevoEscenario();
    const pedido = await syncService.pairingRequest();
    await syncService.pairingPending();
    await syncService.pairingReject(pedido.pairingId);
    await syncService._fetchClaim(pedido.pairingId);
    assert.strictEqual((await syncService.status()).pairing.state, 'rejected');
    await assert.rejects(() => syncService.pairingClaim(pedido.pairingId), /rechaz/i);
  });

  syncService._claims.clear();
  syncService._approvals.clear();
  // `pairingClaim` lanza un sync en segundo plano: si cerramos el servidor
  // antes de que salga, deja un 'fetch failed' en consola que parece un fallo
  // del arnes y no lo es.
  await new Promise(r => setTimeout(r, 300));

  // ── F. Boveda: la clave maestra sale del passphrase de la cuenta ─────────
  //
  // Varios dispositivos en un proceso: cada uno tiene su userData (y con el su
  // llavero, su almacen y su sync-state). `usarDispositivo` espera a que acabe
  // lo que hubiera en la cadena de sync y cambia todas las rutas cacheadas.
  const dispositivos = new Map();
  const usarDispositivo = async nombre => {
    if (syncService._chain) { try { await syncService._chain; } catch (_) { /* ignore */ } }
    let dir = dispositivos.get(nombre);
    if (!dir) {
      dir = fs.mkdtempSync(path.join(userData, `disp-${nombre}-`));
      dispositivos.set(nombre, dir);
    }
    currentUserData = dir;
    cryptoService._cache = null;
    cryptoService._dataDir = null;
    storeService.dataDir = path.join(dir, 'data');
    storeService._initialized = false;
    syncService.state = {
      cursor: 0, lastSyncAt: null, email: null, deviceName: null,
      secretsVersion: 1, shadow: {}, vault: null, undecryptable: {},
    };
    syncService._loaded = false;
    syncService._chain = null;
    syncService._error = null;
    syncService._claims.clear();
    syncService._approvals.clear();
    if (!(await cryptoService.getToken())) await cryptoService.setToken(`token-${nombre}`);
    return dir;
  };

  let srv = null;
  const nuevoServidor = async () => {
    if (syncService._chain) { try { await syncService._chain; } catch (_) { /* ignore */ } }
    if (srv) await srv.close();
    srv = fakeServer();
    await srv.listen();
    process.env.TERMILAB_SYNC_URL = srv.url();
    return srv;
  };

  const filaBoveda = vault => ({
    collection: 'settings', item_id: '__vault__', enc: false, payload: vault,
    ciphertext: null, nonce: null, deleted: false, updated_at: new Date().toISOString(),
  });
  const MARCA_SOBRE = 'aes-256-gcm/v1';
  const abreSobre = (key, sobre) => cryptoService.decryptWith(key, sobre.ciphertext, sobre.nonce);
  const silenciaErrores = async fn => {
    const real = console.error;
    console.error = () => {};
    try { return await fn(); } finally { console.error = real; }
  };

  // T3 ───────────────────────────────────────────────────────
  await nuevoServidor();
  await check('T3 tras el login no se crea ninguna clave maestra', async () => {
    await usarDispositivo('login');
    await cryptoService.clearAll();
    assert.strictEqual(typeof cryptoService.ensureMasterKey, 'undefined',
      'ensureMasterKey sigue existiendo: alguien puede volver a generar claves al azar');
    await syncService.login();
    await syncService._chain;   // el sync que lanza el login
    assert.strictEqual(await cryptoService.getToken(), 'token-login', 'el login no guardo el token');
    assert.strictEqual(await cryptoService.hasMasterKey(), false, 'EL LOGIN HA CREADO UNA CLAVE MAESTRA');
    const disco = JSON.parse(fs.readFileSync(path.join(currentUserData, 'data', 'sync-secrets.json'), 'utf-8'));
    assert.strictEqual(disco.masterKey, null, 'hay una clave maestra en el llavero tras el login');
    const status = await syncService.status();
    assert.strictEqual(status.unlocked, false);
    assert.strictEqual(status.vaultExists, false);
  });

  // T1 + T6 ──────────────────────────────────────────────────
  await nuevoServidor();
  const SECRETO_A = 'contrasena-del-host-de-A';
  const PRIVADA_A = '-----BEGIN OPENSSH PRIVATE KEY----- de A';
  const t1 = {};
  await check('T1 dos dispositivos con el mismo passphrase: misma clave, y B abre lo de A', async () => {
    await usarDispositivo('A');
    await storeService.writeRaw('hosts', [{ ...hostConPassword, id: 'host-A', password: SECRETO_A }]);
    await storeService.writeRaw('keys', [{ id: 'key-A', name: 'A', privateKey: PRIVADA_A }]);
    const r = await syncService.setupPassphrase(PASS_T1);
    assert.deepStrictEqual(r, { unlocked: true, synced: true });
    t1.claveA = await cryptoService.getMasterKey();
    clavesDerivadas.push(t1.claveA);
    const cable = srv.allBodies();
    assert.ok(!cable.includes(SECRETO_A) && !cable.includes(PRIVADA_A), 'A subio un secreto en claro');
    assert.ok(srv.rowFor('settings', '__vault__'), 'la boveda no viajo como settings/__vault__');
    assert.strictEqual(srv.rowFor('keys', 'key-A').enc, true, 'la clave SSH de A no subio cifrada');

    await usarDispositivo('B');
    await syncService.syncNow();
    let status = await syncService.status();
    assert.strictEqual(status.hasMasterKey, false, 'B tiene clave sin haber metido el passphrase');
    assert.strictEqual(status.vaultExists, true, 'B no vio la boveda');
    assert.strictEqual(status.unlocked, false);
    assert.strictEqual(status.undecryptableCount, 2, `B deberia contar 2 objetos cifrados, cuenta ${status.undecryptableCount}`);

    await syncService.unlock(PASS_T1);
    const claveB = await cryptoService.getMasterKey();
    assert.ok(claveB && claveB.equals(t1.claveA), 'B derivo una clave distinta con el mismo passphrase');
    const host = (await storeService.readRaw('hosts')).find(h => h.id === 'host-A');
    assert.strictEqual(host && host.password, SECRETO_A, 'B no abrio la contrasena de A');
    const key = (await storeService.readRaw('keys')).find(k => k.id === 'key-A');
    assert.strictEqual(key && key.privateKey, PRIVADA_A, 'B no abrio la clave SSH de A');
    status = await syncService.status();
    assert.strictEqual(status.unlocked, true);
    assert.strictEqual(status.undecryptableCount, 0, 'tras desbloquear sigue habiendo cosas sin abrir');
  });

  await check('T6 __vault__ nunca aparece en settings.json', async () => {
    let revisados = 0;
    for (const nombre of ['A', 'B']) {
      const file = path.join(dispositivos.get(nombre), 'data', 'settings.json');
      if (!fs.existsSync(file)) continue;
      revisados++;
      const texto = fs.readFileSync(file, 'utf-8');
      const vault = srv.rowFor('settings', '__vault__').payload;
      assert.ok(!texto.includes('__vault__'), `${nombre}: __vault__ dentro de settings.json`);
      assert.ok(!texto.includes(vault.salt) && !texto.includes(vault.verifier.ciphertext),
        `${nombre}: la boveda se colo en settings.json`);
    }
    // B bajo los ajustes de A, asi que su settings.json existe y es la prueba real.
    assert.ok(revisados >= 1, 'ningun dispositivo escribio settings.json: la prueba no prueba nada');
    const settingsRow = srv.rowFor('settings', 'settings');
    assert.ok(settingsRow && !JSON.stringify(settingsRow).includes('__vault__'),
      'la fila de ajustes que sube lleva la boveda dentro');
  });

  // T5 ───────────────────────────────────────────────────────
  await check('T5 emparejar con una clave que no pasa el verificador se rechaza', async () => {
    await usarDispositivo('P');
    const OTRA = Buffer.alloc(32, 9);
    await cryptoService.setMasterKey(OTRA);   // la "aprobadora" trae una clave ajena
    const pedido = await syncService.pairingRequest();
    await syncService.pairingPending();
    await syncService.pairingApprove(pedido.pairingId);
    await syncService.pairingConfirm(pedido.pairingId);

    await cryptoService.clearAll();
    await cryptoService.setToken('token-P');
    await syncService._fetchClaim(pedido.pairingId);
    await assert.rejects(
      () => syncService.pairingClaim(pedido.pairingId),
      err => /no corresponde al passphrase/.test(err.message),
      'se acepto una clave que no abre la boveda'
    );
    assert.strictEqual(await cryptoService.hasMasterKey(), false, 'se instalo la clave rechazada');
    const status = await syncService.status();
    assert.strictEqual(status.unlocked, false);
    assert.strictEqual(status.pairing && status.pairing.state, 'rejected');
    syncService._claims.clear();
    syncService._approvals.clear();
  });

  // T2 ───────────────────────────────────────────────────────
  await check('T2 passphrase incorrecto: error, clave sin cambios, nada subido', async () => {
    await usarDispositivo('W');
    const LEGACY_W = Buffer.alloc(32, 5);
    await cryptoService.setMasterKey(LEGACY_W);
    await storeService.writeRaw('hosts', [{ ...hostConPassword, id: 'host-W', password: 'secreto-de-W' }]);
    await silenciaErrores(() => syncService.syncNow());   // "ninguna clave abre..." es lo esperado
    srv.reset();

    // Por el puente de verdad, como lo llamara la interfaz.
    await assert.rejects(() => bridge.sync.unlock(PASS_MAL), err => err.message === 'Passphrase incorrecto');
    await assert.rejects(() => bridge.sync.unlock('corta'), /al menos 6 caracteres/);
    await assert.rejects(() => bridge.sync.setupPassphrase('corta'), /al menos 6 caracteres/);
    // El limite exacto: 5 no, 6 si. Contado en puntos de codigo, no en UTF-16.
    assert.throws(() => cryptoService.validatePassphrase('12345'), /al menos 6 caracteres/);
    assert.doesNotThrow(() => cryptoService.validatePassphrase('123456'));
    assert.throws(() => cryptoService.validatePassphrase('\u{1F511}'.repeat(5)), /al menos 6 caracteres/);
    await assert.rejects(() => bridge.sync.setupPassphrase(PASS_MAL), /ya tiene passphrase/);

    assert.deepStrictEqual(srv.syncPosts(), [], 'se subio algo con un passphrase incorrecto');
    const clave = await cryptoService.getMasterKey();
    assert.ok(clave && clave.equals(LEGACY_W), 'la clave cambio tras un passphrase incorrecto');
    assert.strictEqual(await cryptoService.getVaultSalt(), null);
    assert.deepStrictEqual(await cryptoService.getLegacyKeys(), [], 'aparecieron claves legacy');
    assert.strictEqual((await syncService.status()).unlocked, false);
    const vault = srv.rowFor('settings', '__vault__').payload;
    assert.ok(cryptoService.verifyVaultKey(t1.claveA, vault), 'la boveda de la cuenta cambio');
    // R6: con la clave legacy tampoco se sella nada.
    assert.ok(!srv.allBodies().includes(MARCA_SOBRE), 'se sello algo con una clave sin verificar');
  });


  // T10 ──────────────────────────────────────────────────────
  await check('T10 lo que baja sellado con una clave ajena no se re-sella ni se sube desde aqui', async () => {
    const AJENA = Buffer.alloc(32, 13);
    const filaKey = {
      collection: 'keys', item_id: 'key-ajena', enc: true, payload: null,
      ...cryptoService.encryptWith(AJENA, JSON.stringify({ id: 'key-ajena', name: 'remota', privateKey: 'remota-nueva' })),
      deleted: false, updated_at: '2030-01-01T00:00:00.000Z',
    };
    const filaHost = {
      collection: 'hosts', item_id: 'host-ajeno', enc: false, ciphertext: null, nonce: null,
      payload: {
        ...hostConPassword, id: 'host-ajeno', label: 'Remota', updatedAt: '2030-01-01T00:00:00.000Z',
        password: { enc: MARCA_SOBRE, ...cryptoService.encryptWith(AJENA, 'remota-nueva') },
      },
      deleted: false, updated_at: '2030-01-01T00:00:00.000Z',
    };
    srv.inject(filaKey);
    srv.inject(filaHost);

    await usarDispositivo('R');
    await storeService.writeRaw('hosts', [{ ...hostConPassword, id: 'host-ajeno', password: 'local-vieja-de-R' }]);
    await storeService.writeRaw('keys', [{ id: 'key-ajena', name: 'local', privateKey: 'local-vieja-de-R' }]);
    await syncService.syncNow();
    await silenciaErrores(() => syncService.unlock(PASS_T1));
    await syncService.syncNow();

    const host = srv.rowFor('hosts', 'host-ajeno');
    assert.deepStrictEqual(host.payload.password, filaHost.payload.password,
      'SE PISO la contrasena remota que este equipo no puede abrir');
    const key = srv.rowFor('keys', 'key-ajena');
    assert.deepStrictEqual([key.ciphertext, key.nonce], [filaKey.ciphertext, filaKey.nonce],
      'SE PISO la clave SSH remota que este equipo no puede abrir');
    assert.ok(!srv.allBodies().includes('local-vieja-de-R'), 'y encima en claro');
    const status = await syncService.status();
    assert.strictEqual(status.unlocked, true);
    assert.strictEqual(status.undecryptableCount, 2, `deberia seguir avisando de 2, avisa de ${status.undecryptableCount}`);
    assert.strictEqual(status.error, null, `lo ilegible lo cuenta undecryptableCount, no error: ${status.error}`);
    const local = (await storeService.readRaw('hosts')).find(h => h.id === 'host-ajeno');
    assert.strictEqual(local.password, 'local-vieja-de-R', 'se perdio la contrasena local');
  });

  // T11 ──────────────────────────────────────────────────────
  await check('T11 emparejar sin red y sin boveda en disco no instala nada', async () => {
    await usarDispositivo('Q');
    await cryptoService.setMasterKey(t1.claveA, { vaultSalt: srv.rowFor('settings', '__vault__').payload.salt });
    const pedido = await syncService.pairingRequest();
    await syncService.pairingPending();
    await syncService.pairingApprove(pedido.pairingId);
    await syncService.pairingConfirm(pedido.pairingId);
    await cryptoService.clearAll();
    await cryptoService.setToken('token-Q');
    assert.strictEqual(syncService.state.vault, null, 'el escenario necesita un equipo sin boveda en disco');
    await syncService._fetchClaim(pedido.pairingId);

    srv.hooks.failSyncGet = true;
    try {
      await silenciaErrores(() => assert.rejects(
        () => syncService.pairingClaim(pedido.pairingId),
        err => /hace falta conexion/.test(err.message),
        'sin red se instalo (o se rechazo con otro motivo) una clave sin verificar'
      ));
    } finally { srv.hooks.failSyncGet = false; }
    assert.strictEqual(await cryptoService.hasMasterKey(), false, 'SE INSTALO UNA CLAVE SIN VERIFICAR');
    assert.strictEqual((await syncService.status()).pairing.state, 'listo', 'deberia poder reintentarse');

    // Con red vuelve a intentarse y ahora si se verifica e instala.
    await syncService.pairingClaim(pedido.pairingId);
    const clave = await cryptoService.getMasterKey();
    assert.ok(clave && clave.equals(t1.claveA));
    assert.strictEqual((await syncService.status()).unlocked, true);
  });

  // T4 ───────────────────────────────────────────────────────
  await nuevoServidor();
  const LEGACY = Buffer.alloc(32, 4);
  await check('T4 migracion: lo sellado con la clave legacy se re-sella y lo abre quien solo sabe el passphrase', async () => {
    // Lo que dejo en el servidor una version anterior, con su clave aleatoria.
    srv.inject({
      collection: 'keys', item_id: 'key-legacy', enc: true, payload: null,
      ...cryptoService.encryptWith(LEGACY, JSON.stringify({ id: 'key-legacy', name: 'vieja', privateKey: 'PRIVADA-LEGACY' })),
      deleted: false, updated_at: '2026-01-01T00:00:00.000Z',
    });
    srv.inject({
      collection: 'hosts', item_id: 'host-legacy', enc: false, ciphertext: null, nonce: null,
      payload: {
        ...hostConPassword, id: 'host-legacy', label: 'Vieja',
        password: { enc: MARCA_SOBRE, ...cryptoService.encryptWith(LEGACY, 'pass-legacy') },
      },
      deleted: false, updated_at: '2026-01-01T00:00:00.000Z',
    });

    // E crea la boveda sin conocer la clave legacy: ve dos cosas que no abre.
    await usarDispositivo('E4');
    await silenciaErrores(() => syncService.setupPassphrase(PASS_T4));
    assert.strictEqual((await syncService.status()).undecryptableCount, 2);

    // C es el equipo viejo: tiene la clave legacy y NINGUNA copia local, asi
    // que lo remoto solo se puede abrir con la legacy. Y el servidor se cae
    // justo al subir: la legacy NO puede perderse hasta que lo re-sellado suba.
    await usarDispositivo('C4');
    await cryptoService.setMasterKey(LEGACY);
    srv.hooks.failSyncPost = true;
    const cortado = await silenciaErrores(() => syncService.unlock(PASS_T4));
    srv.hooks.failSyncPost = false;
    assert.deepStrictEqual(cortado, { unlocked: true, synced: false });
    const claveCuenta = await cryptoService.getMasterKey();
    clavesDerivadas.push(claveCuenta);
    const legacyTrasCorte = await cryptoService.getLegacyKeys();
    assert.ok(legacyTrasCorte.length === 1 && legacyTrasCorte[0].equals(LEGACY),
      'la legacy se perdio antes de subir lo re-sellado');
    assert.strictEqual(abreSobre(LEGACY, srv.rowFor('hosts', 'host-legacy').payload.password), 'pass-legacy',
      'el servidor cambio pese a la caida');

    // Vuelve el servidor: el sync siguiente termina la migracion.
    await syncService.syncNow();
    assert.deepStrictEqual(await cryptoService.getLegacyKeys(), [], 'la legacy no se descarto tras subir');

    const keyRow = srv.rowFor('keys', 'key-legacy');
    assert.strictEqual(JSON.parse(cryptoService.decryptWith(claveCuenta, keyRow.ciphertext, keyRow.nonce)).privateKey,
      'PRIVADA-LEGACY', 'la clave SSH remota no quedo re-sellada con la de la cuenta');
    assert.strictEqual(abreSobre(claveCuenta, srv.rowFor('hosts', 'host-legacy').payload.password), 'pass-legacy',
      'la contrasena remota no quedo re-sellada con la de la cuenta');

    // F no ha visto nunca la clave legacy: solo sabe el passphrase.
    await usarDispositivo('F4');
    await syncService.unlock(PASS_T4);
    const host = (await storeService.readRaw('hosts')).find(h => h.id === 'host-legacy');
    assert.strictEqual(host && host.password, 'pass-legacy', 'F no abre la contrasena migrada');
    const key = (await storeService.readRaw('keys')).find(k => k.id === 'key-legacy');
    assert.strictEqual(key && key.privateKey, 'PRIVADA-LEGACY', 'F no abre la clave SSH migrada');
    assert.strictEqual((await syncService.status()).undecryptableCount, 0);

    await usarDispositivo('E4');
    await syncService.syncNow();
    assert.strictEqual((await syncService.status()).undecryptableCount, 0, 'E sigue sin abrir lo migrado');
  });


  // T9 ───────────────────────────────────────────────────────
  await check('T9 cierre entre llavero y estado: la legacy sobrevive y se re-sella en el siguiente sync', async () => {
    await nuevoServidor();
    const L9 = Buffer.alloc(32, 11);
    srv.inject({
      collection: 'keys', item_id: 'key-l9', enc: true, payload: null,
      ...cryptoService.encryptWith(L9, JSON.stringify({ id: 'key-l9', name: 'vieja', privateKey: 'PRIVADA-L9' })),
      deleted: false, updated_at: '2026-01-01T00:00:00.000Z',
    });
    srv.inject({
      collection: 'hosts', item_id: 'host-l9', enc: false, ciphertext: null, nonce: null,
      payload: { ...hostConPassword, id: 'host-l9', password: { enc: MARCA_SOBRE, ...cryptoService.encryptWith(L9, 'pass-l9') } },
      deleted: false, updated_at: '2026-01-01T00:00:00.000Z',
    });
    await usarDispositivo('E9');
    await silenciaErrores(() => syncService.setupPassphrase(PASS_T4));

    // X9 ya habia sincronizado con su clave vieja: cursor al dia.
    await usarDispositivo('X9');
    await cryptoService.setMasterKey(L9);
    await syncService.syncNow();
    const vault = syncService.state.vault;
    const K = await cryptoService.deriveVaultKey(PASS_T4, vault);
    clavesDerivadas.push(K);
    // El cierre: el llavero ya tiene la clave nueva y la legacy, y el estado se
    // quedo como estaba (cursor al dia, nada marcado, ni copias locales).
    await cryptoService.setMasterKey(K, { vaultSalt: vault.salt, legacyKeys: [L9] });
    await storeService.writeRaw('hosts', []);
    await storeService.writeRaw('keys', []);
    syncService.state.shadow = {};
    syncService.state.resealBaseline = null;
    await syncService._save();
    assert.ok(syncService.state.cursor > 0);

    // Primer sync tras reabrir, y el servidor se cae al subir: la legacy sigue.
    srv.hooks.failSyncPost = true;
    await assert.rejects(() => syncService.syncNow());
    srv.hooks.failSyncPost = false;
    assert.strictEqual((await cryptoService.getLegacyKeys()).length, 1, 'LA LEGACY SE PERDIO SIN RE-SELLAR');

    await syncService.syncNow();
    assert.strictEqual(abreSobre(K, srv.rowFor('hosts', 'host-l9').payload.password), 'pass-l9',
      'la contrasena remota no se re-sello con la clave de la cuenta');
    const keyRow = srv.rowFor('keys', 'key-l9');
    assert.strictEqual(JSON.parse(cryptoService.decryptWith(K, keyRow.ciphertext, keyRow.nonce)).privateKey, 'PRIVADA-L9',
      'la clave SSH remota no se re-sello con la clave de la cuenta');
    assert.deepStrictEqual(await cryptoService.getLegacyKeys(), [], 'la legacy no se descarto tras re-sellar');
  });

  // T7 ───────────────────────────────────────────────────────
  await check('T7 boveda creada a la vez: el perdedor queda bloqueado, no divergente', async () => {
    // a) Se entera al crearla: tras subir la suya, el servidor tiene la del otro.
    await nuevoServidor();
    const rival = await cryptoService.createVault(PASS_H);
    clavesDerivadas.push(rival.key);
    await usarDispositivo('G');
    await storeService.writeRaw('hosts', [{ ...hostConPassword, id: 'host-G', password: 'secreto-de-G' }]);
    srv.hooks.afterVaultPush = () => { srv.hooks.afterVaultPush = null; srv.inject(filaBoveda(rival.vault)); };
    await assert.rejects(() => syncService.setupPassphrase(PASS_G), /a la vez/);
    assert.strictEqual(await cryptoService.hasMasterKey(), false, 'el perdedor instalo su clave');
    let status = await syncService.status();
    assert.deepStrictEqual([status.vaultExists, status.unlocked], [true, false]);
    assert.ok(!srv.allBodies().includes(MARCA_SOBRE), 'el perdedor sello secretos con su clave');
    await syncService.unlock(PASS_H);
    assert.strictEqual(abreSobre(rival.key, srv.rowFor('hosts', 'host-G').payload.password), 'secreto-de-G');

    // b) Se entera despues: creyo ganar, y la boveda del otro llega en un sync.
    await nuevoServidor();
    const rival2 = await cryptoService.createVault(PASS_H);
    clavesDerivadas.push(rival2.key);
    await usarDispositivo('G2');
    await storeService.writeRaw('hosts', [{ ...hostConPassword, id: 'host-G2', password: 'secreto-de-G2' }]);
    await syncService.setupPassphrase(PASS_G);
    const claveG = await cryptoService.getMasterKey();
    clavesDerivadas.push(claveG);
    srv.inject(filaBoveda(rival2.vault));
    await storeService.writeRaw('hosts', [{
      ...hostConPassword, id: 'host-G2', password: 'secreto-nuevo-G2', updatedAt: '2030-01-01T00:00:00.000Z',
    }]);
    srv.reset();
    await syncService.syncNow();
    status = await syncService.status();
    assert.strictEqual(status.unlocked, false, 'sigue desbloqueado con una clave que no es la de la boveda vigente');
    assert.deepStrictEqual([status.vaultExists, status.hasMasterKey], [true, true]);
    assert.strictEqual(status.error, null, `quedar bloqueado no es un error: ${status.error}`);
    const subido = srv.syncPosts().join('\n');
    assert.ok(subido.length > 0, 'no subio el host editado');
    assert.ok(!subido.includes(MARCA_SOBRE) && !subido.includes('"enc":true'),
      'SELLO CON LA CLAVE DE UNA BOVEDA QUE YA NO ES LA VIGENTE');
    assert.ok(!subido.includes('secreto-nuevo-G2'), 'subio el secreto en claro');

    await syncService.unlock(PASS_H);
    assert.strictEqual(abreSobre(rival2.key, srv.rowFor('hosts', 'host-G2').payload.password), 'secreto-nuevo-G2',
      'tras desbloquear no se re-sello con la clave vigente');
    assert.deepStrictEqual(await cryptoService.getLegacyKeys(), []);
  });

  if (syncService._chain) { try { await syncService._chain; } catch (_) { /* ignore */ } }
  await new Promise(r => setTimeout(r, 100));

  // T8 ───────────────────────────────────────────────────────
  await check('T8 ni el passphrase ni la clave derivada salen por consola, renderer, disco o cable', () => {
    const leeTodo = dir => {
      let out = '';
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out += leeTodo(full);
        else out += `\n${fs.readFileSync(full, 'utf-8')}`;
      }
      return out;
    };
    const salidas = {
      consola: consola.join('\n') + '\n' + results.join('\n'),
      renderer: alRenderer.join('\n'),
      disco: leeTodo(userData),
      cable: cableTotal.join('\n'),
    };
    assert.ok(salidas.consola.length > 0 && salidas.renderer.length > 0, 'no se capturo nada: la prueba no prueba');
    for (const [donde, texto] of Object.entries(salidas)) {
      for (const pass of PASSPHRASES_BOVEDA) {
        assert.ok(!texto.includes(pass), `un passphrase aparece en ${donde}`);
      }
      if (donde === 'disco') continue;   // el llavero falso del arnes guarda la clave "envuelta" en claro
      for (const clave of clavesDerivadas) {
        assert.ok(!texto.includes(clave.toString('base64')) && !texto.includes(clave.toString('hex')),
          `una clave derivada aparece en ${donde}`);
      }
    }
  });
  if (srv) await srv.close();

  await api.close();
  Module._load = realLoad;
  await fsp.rm(userData, { recursive: true, force: true });

  console.log(results.join('\n'));
  console.log(failures ? `\n${failures} comprobacion(es) fallidas` : '\nTodo en verde');
  process.exit(failures ? 1 : 0);
}

main().catch(err => {
  console.error(results.join('\n'));
  console.error('\nEl arnes reviento:', err);
  process.exit(1);
});
