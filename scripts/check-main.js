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
    on: () => {},
    removeListener: () => {},
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
  let cursor = 0;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (raw) bodies.push(raw);
      const url = new URL(req.url, 'http://localhost');
      res.setHeader('content-type', 'application/json');

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

      if (url.pathname === '/v1/pair/pending') {
        res.end(JSON.stringify({ pairings: [] }));
        return;
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
    reset: () => { bodies.length = 0; },
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
