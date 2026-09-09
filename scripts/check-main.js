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
    getPath: () => userData,
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
      this.webContents = { send: () => {}, on: () => {}, setWindowOpenHandler: () => {}, session: { on: () => {} } };
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

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (raw) bodies.push(raw);
      const url = new URL(req.url, 'http://localhost');
      requests.push({ method: req.method, path: url.pathname, raw });
      res.setHeader('content-type', 'application/json');
      const json = (code, data) => { res.statusCode = code; res.end(JSON.stringify(data)); };

      if (req.method === 'POST' && url.pathname === '/v1/sync') {
        const records = (JSON.parse(raw || '{}').records) || [];
        for (const record of records) {
          if (record.payload !== null && record.ciphertext !== null) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'payload y ciphertext a la vez' }));
            return;
          }
          const index = rows.findIndex(
            r => r.record.collection === record.collection && r.record.item_id === record.item_id
          );
          const entry = { cursor: ++cursor, record };
          if (index !== -1) rows.splice(index, 1);
          rows.push(entry);
        }
        res.end(JSON.stringify({ applied: records.length, cursor }));
        return;
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
  await cryptoService.setMasterKey(Buffer.alloc(32, 7));
  await storeService.writeRaw('hosts', [hostConPassword, hostConClave]);
  await resetSync();
  api.reset();
  await syncService.syncNow();

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
    assert.ok(/clave maestra/i.test(status.error || ''), `error poco claro: ${status.error}`);
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

  await check('al emparejar despues, el secreto pendiente si sube', async () => {
    await cryptoService.setMasterKey(Buffer.alloc(32, 7));
    api.reset();
    await syncService.syncNow();
    const payload = api.rowFor('hosts', 'host-4').payload;
    assert.strictEqual(typeof payload.password, 'object', 'no reenvio el secreto tras emparejar');
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
  const MASTER = Buffer.alloc(32, 42);

  const nuevoEscenario = async () => {
    syncService._claims.clear();
    syncService._approvals.clear();
    api.resetPairings();
    api.reset();
    await cryptoService.clearAll();
    await cryptoService.setToken('token-de-prueba');
    await cryptoService.setMasterKey(MASTER);
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
