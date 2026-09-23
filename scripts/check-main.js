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
const PASS_S = 'frase-de-los-known-hosts-sincronizados';
const PASSPHRASES_BOVEDA = [PASS_CUENTA, PASS_T1, PASS_T4, PASS_MAL, PASS_G, PASS_H, PASS_S];
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

/* La lista blanca del servidor REAL, leida de su fuente: el falso rechaza con
   400 lo mismo que el real, asi que olvidar una coleccion alli pone esto rojo. */
const COLECCIONES_SERVIDOR = (() => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'api', 'src', 'server.js'), 'utf-8');
  const m = src.match(/const COLLECTIONS = \[([^\]]*)\]/);
  if (!m) throw new Error('no encuentro COLLECTIONS en server/api/src/server.js');
  return new Set([...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]));
})();

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
        const fuera = records.find(r => !COLECCIONES_SERVIDOR.has(r.collection) || !r.item_id);
        if (fuera) return json(400, { error: `registro invalido: ${fuera.collection}` });
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

// ─── K. Known hosts y logs ──────────────────────────────────

/**
 * Parser de known_hosts, huella en formato OpenSSH (contra `ssh-keygen -lf`),
 * la decision del verificador con su dialogo (aceptar sin preguntar, preguntar,
 * 'changed', caducidad, sin ventana, dos conexiones a la vez) y el historial.
 * El verificador se prueba con una ventana falsa propia: lo que se manda al
 * renderer se mira aqui, no en `alRenderer`.
 */
async function seccionKnownHosts() {
  const kh = require(path.join(ROOT, 'electron', 'services', 'known-hosts.js'));
  const hostKeyService = require(path.join(ROOT, 'electron', 'services', 'host-key-service.js'));
  const logService = require(path.join(ROOT, 'electron', 'services', 'connection-log-service.js'));
  const storeService = require(path.join(ROOT, 'electron', 'services', 'store-service.js'));

  // Claves de verdad, hechas por ssh-keygen: la huella se compara con la suya.
  const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termilab-kh-'));
  const claves = {};
  let sinKeygen = null;
  try {
    for (const [nombre, tipo] of [['ed', 'ed25519'], ['ed2', 'ed25519'], ['rsa', 'rsa'], ['ec', 'ecdsa']]) {
      const file = path.join(keyDir, nombre);
      execFileSync('ssh-keygen', ['-q', '-t', tipo, '-N', '', '-C', `arnes-${nombre}`, '-f', file], { stdio: 'pipe' });
      const pub = fs.readFileSync(`${file}.pub`, 'utf-8').trim().split(/\s+/);
      const lf = execFileSync('ssh-keygen', ['-lf', `${file}.pub`], { encoding: 'utf-8' }).trim().split(/\s+/)[1];
      claves[nombre] = { type: pub[0], b64: pub[1], blob: Buffer.from(pub[1], 'base64'), lf, file: `${file}.pub` };
    }
  } catch (err) {
    sinKeygen = err.message;
  }

  await check('K1 huella SHA256 identica a `ssh-keygen -lf` (ed25519, rsa, ecdsa)', () => {
    assert.ok(!sinKeygen, `ssh-keygen no disponible: ${sinKeygen}`);
    for (const nombre of ['ed', 'rsa', 'ec']) {
      const c = claves[nombre];
      assert.strictEqual(kh.fingerprint(c.blob), c.lf, `${nombre}: huella distinta de ssh-keygen`);
      assert.ok(!c.lf.endsWith('='), 'la huella de OpenSSH no lleva relleno');
      assert.strictEqual(kh.blobKeyType(c.blob), c.type, `${nombre}: tipo mal leido del blob`);
    }
  });

  await check('K2 parser de known_hosts: plano, [h]:p, lista con comas; fuera hashed, @cert-authority, @revoked, basura', () => {
    assert.ok(!sinKeygen, 'sin claves');
    const { ed, rsa, ec } = claves;
    const texto = [
      '# comentario',
      '',
      `Web.Example.com ${ed.type} ${ed.b64} comentario libre`,
      `[bastion.example.com]:2200 ${rsa.type} ${rsa.b64}`,
      `a.example,10.0.0.9,[10.0.0.9]:2222 ${ec.type} ${ec.b64}`,
      `|1|F1E1KeoE/eEWhi10WpGv4OdiO6Y=|3988QV0VE8wmZL7suNrYQLITLCg= ${ed.type} ${ed.b64}`,
      `@cert-authority *.example.com ${ed.type} ${ed.b64}`,
      `@revoked web.example.com ${ed.type} ${ed.b64}`,
      `*.wild.example ${ed.type} ${ed.b64}`,
      `cert.example ssh-ed25519-cert-v01@openssh.com ${ed.b64}`,
      'esto no es una linea valida',
      `mal.example ${ed.type} !!!nobase64!!!`,
      `tipo.cruzado ${rsa.type} ${ed.b64}`,
    ].join('\n');
    const r = kh.parseKnownHosts(texto);
    const got = r.entries.map(e => `${e.host}:${e.port} ${e.keyType}`);
    assert.deepStrictEqual(got, [
      `web.example.com:22 ${ed.type}`,
      `bastion.example.com:2200 ${rsa.type}`,
      `a.example:22 ${ec.type}`,
      `10.0.0.9:22 ${ec.type}`,
      `10.0.0.9:2222 ${ec.type}`,
    ]);
    assert.strictEqual(r.entries[0].fingerprint, ed.lf, 'la huella importada no es la de ssh-keygen');
    assert.strictEqual(r.entries[0].key, ed.b64);
    assert.deepStrictEqual(r.reasons, { hashed: 1, unsupported: 4, malformed: 3 });
    assert.strictEqual(r.skipped, 8);
    assert.strictEqual(kh.displayHost('Web.Example.com', 22), 'web.example.com');
    assert.strictEqual(kh.displayHost('10.0.0.9', 2222), '[10.0.0.9]:2222');
  });

  await check('K3 importar ~/.ssh/known_hosts por IPC: cuenta y no duplica', async () => {
    assert.ok(!sinKeygen, 'sin claves');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'termilab-home-'));
    fs.mkdirSync(path.join(home, '.ssh'));
    fs.writeFileSync(path.join(home, '.ssh', 'known_hosts'), [
      `imp.example,[imp.example]:2022 ${claves.ed.type} ${claves.ed.b64}`,
      `imp.example ${claves.rsa.type} ${claves.rsa.b64}`,
      `|1|abc=|def= ${claves.ed.type} ${claves.ed.b64}`,
      `@cert-authority * ${claves.ed.type} ${claves.ed.b64}`,
    ].join('\n'));
    const realHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const primera = await bridge.knownHosts.importFromSsh();
      assert.strictEqual(primera.imported, 3, `importo ${primera.imported}, esperaba 3`);
      assert.strictEqual(primera.skipped, 2);
      assert.deepStrictEqual(primera.reasons, { hashed: 1, unsupported: 1, malformed: 0 });
      const segunda = await bridge.knownHosts.importFromSsh();
      assert.strictEqual(segunda.imported, 0, 'la segunda importacion duplico entradas');
      assert.strictEqual(segunda.duplicates, 3);
      const lista = await bridge.knownHosts.list();
      assert.strictEqual(lista.length, 3);
      assert.ok(lista.every(e => e.id && e.addedAt && e.fingerprint.startsWith('SHA256:')), 'entradas incompletas');
      assert.ok(await bridge.knownHosts.delete(lista[0].id));
      assert.strictEqual((await bridge.knownHosts.list()).length, 2);
    } finally {
      process.env.HOME = realHome;
      await storeService.writeRaw('known-hosts', []);
    }
  });

  // Ventana falsa: recoge lo que el verificador manda y deja contestar.
  const enviados = [];
  let vivo = true;
  const ventana = {
    isDestroyed: () => !vivo,
    webContents: { send: (canal, datos) => enviados.push([canal, datos]), isDestroyed: () => !vivo },
  };
  const ventanaOriginal = hostKeyService.mainWindow;
  hostKeyService.setMainWindow(ventana);
  const prompts = () => enviados.filter(([c]) => c === 'ssh:host-key-prompt').map(([, d]) => d);
  const cancels = () => enviados.filter(([c]) => c === 'ssh:host-key-prompt-cancel').map(([, d]) => d);
  const esperaPrompt = async (n) => {
    for (let i = 0; i < 200 && prompts().length < n; i++) await new Promise(r => setTimeout(r, 5));
    assert.ok(prompts().length >= n, `no llego el aviso n.${n}`);
    return prompts()[n - 1];
  };

  await check('K4 verificador: desconocido pregunta; aceptar guarda; la siguiente vez acepta sin preguntar', async () => {
    assert.ok(!sinKeygen, 'sin claves');
    enviados.length = 0;
    const v = hostKeyService.verify('Srv.Example', 22, claves.ed.blob);
    const p = await esperaPrompt(1);
    assert.strictEqual(p.reason, 'unknown');
    assert.strictEqual(p.host, 'srv.example');
    assert.strictEqual(p.port, 22);
    assert.strictEqual(p.keyType, 'ssh-ed25519');
    assert.strictEqual(p.fingerprint, claves.ed.lf);
    assert.ok(p.requestId && !('previousFingerprint' in p));
    assert.strictEqual(await bridge.ssh.respondHostKey(p.requestId, true), true);
    assert.strictEqual(await v, true, 'aceptado pero el verificador dijo que no');
    const guardadas = await storeService.getKnownHosts();
    assert.strictEqual(guardadas.length, 1);
    assert.strictEqual(guardadas[0].fingerprint, claves.ed.lf);

    enviados.length = 0;
    assert.strictEqual(await hostKeyService.verify('srv.example', 22, claves.ed.blob), true);
    assert.strictEqual(enviados.length, 0, 'con la clave conocida no debe preguntar nada');
    // Otro puerto es otro host
    const otro = hostKeyService.verify('srv.example', 2222, claves.ed.blob);
    const p2 = await esperaPrompt(1);
    assert.strictEqual(p2.reason, 'unknown', 'srv.example:2222 no es srv.example:22');
    await bridge.ssh.respondHostKey(p2.requestId, false);
    assert.strictEqual(await otro, false);
  });

  await check('K5 verificador: clave cambiada pregunta con "changed" y la huella vieja; rechazar no toca el almacen', async () => {
    assert.ok(!sinKeygen, 'sin claves');
    enviados.length = 0;
    const v = hostKeyService.verify('srv.example', 22, claves.ed2.blob);
    const p = await esperaPrompt(1);
    assert.strictEqual(p.reason, 'changed');
    assert.strictEqual(p.previousFingerprint, claves.ed.lf);
    assert.strictEqual(p.fingerprint, claves.ed2.lf);
    await bridge.ssh.respondHostKey(p.requestId, false);
    assert.strictEqual(await v, false, 'rechazada pero paso');
    const guardadas = await storeService.getKnownHosts();
    assert.strictEqual(guardadas.length, 1);
    assert.strictEqual(guardadas[0].fingerprint, claves.ed.lf, 'rechazar cambio la clave guardada');

    // Aceptar el cambio sustituye (y se lleva los otros tipos de ese host:puerto)
    await storeService.saveKnownHost({ host: 'srv.example', port: 22, keyType: claves.rsa.type, key: claves.rsa.b64, fingerprint: claves.rsa.lf });
    enviados.length = 0;
    const v2 = hostKeyService.verify('srv.example', 22, claves.ed2.blob);
    const p2 = await esperaPrompt(1);
    await bridge.ssh.respondHostKey(p2.requestId, true);
    assert.strictEqual(await v2, true);
    const tras = await storeService.getKnownHosts();
    assert.deepStrictEqual(tras.map(e => e.fingerprint), [claves.ed2.lf], 'la identidad vieja sigue guardada');

    // Un tipo distinto del conocido tampoco es "unknown": 'new-key-type' (ver K14)
    enviados.length = 0;
    const v3 = hostKeyService.verify('srv.example', 22, claves.ec.blob);
    const p3 = await esperaPrompt(1);
    assert.strictEqual(p3.reason, 'new-key-type');
    assert.deepStrictEqual(p3.knownTypes, ['ssh-ed25519']);
    await bridge.ssh.respondHostKey(p3.requestId, false);
    assert.strictEqual(await v3, false);
  });

  await check('K6 verificador: sin respuesta caduca y rechaza (y cierra el dialogo)', async () => {
    assert.ok(!sinKeygen, 'sin claves');
    assert.strictEqual(hostKeyService.PROMPT_TIMEOUT_MS, 120000, 'la caducidad no es de 120 s');
    const real = hostKeyService.timeoutMs;
    hostKeyService.timeoutMs = 60;
    enviados.length = 0;
    try {
      const t0 = Date.now();
      const ok = await hostKeyService.verify('lento.example', 22, claves.rsa.blob);
      assert.strictEqual(ok, false, 'sin respuesta acepto');
      assert.ok(Date.now() - t0 >= 50, 'rechazo antes de caducar');
      const p = prompts()[0];
      assert.ok(p, 'no pregunto');
      assert.deepStrictEqual(cancels().map(c => c.requestId), [p.requestId], 'no aviso al renderer de que caduco');
      assert.strictEqual(await bridge.ssh.respondHostKey(p.requestId, true), false, 'una respuesta tardia no puede valer');
      assert.ok(!(await storeService.getKnownHosts()).some(e => e.host === 'lento.example'), 'la respuesta tardia guardo la clave');
    } finally {
      hostKeyService.timeoutMs = real;
    }
  });

  await check('K7 verificador: sin ventana rechaza; dos conexiones a la vez comparten un dialogo', async () => {
    assert.ok(!sinKeygen, 'sin claves');
    vivo = false;
    enviados.length = 0;
    assert.strictEqual(await hostKeyService.verify('nadie.example', 22, claves.rsa.blob), false, 'sin ventana acepto');
    assert.strictEqual(enviados.length, 0);
    vivo = true;

    enviados.length = 0;
    const a = hostKeyService.verify('par.example', 22, claves.rsa.blob);
    const p = await esperaPrompt(1);
    const b = hostKeyService.verify('par.example', 22, claves.rsa.blob);
    await new Promise(r => setTimeout(r, 30));
    assert.strictEqual(prompts().length, 1, 'la segunda conexion abrio otro dialogo');
    await bridge.ssh.respondHostKey(p.requestId, true);
    assert.deepStrictEqual(await Promise.all([a, b]), [true, true]);

    // Una conexion que muere mientras pregunta cierra su dialogo
    enviados.length = 0;
    const handle = { cancel: () => {} };
    const c = hostKeyService.verify('muere.example', 22, claves.rsa.blob, { handle });
    const pc = await esperaPrompt(1);
    handle.cancel();
    assert.strictEqual(await c, false);
    assert.deepStrictEqual(cancels().map(x => x.requestId), [pc.requestId]);
  });

  await check('K8 createVerifier habla el hostVerifier(key, verify) asincrono de ssh2', async () => {
    assert.ok(!sinKeygen, 'sin claves');
    enviados.length = 0;
    const pausas = [];
    const v = hostKeyService.createVerifier('par.example', 22, {
      onPrompt: () => pausas.push('prompt'), onSettled: () => pausas.push('settled'),
    });
    const r1 = await new Promise(res => { assert.strictEqual(v.hostVerifier(claves.rsa.blob, res), undefined); });
    assert.strictEqual(r1, true);
    assert.deepStrictEqual(pausas, [], 'clave conocida: no hay nada que pausar');

    const v2 = hostKeyService.createVerifier('par.example', 22, {
      onPrompt: () => pausas.push('prompt'), onSettled: () => pausas.push('settled'),
    });
    const r2p = new Promise(res => v2.hostVerifier(claves.ed.blob, res));
    const p = await esperaPrompt(1);
    await bridge.ssh.respondHostKey(p.requestId, false);
    assert.strictEqual(await r2p, false);
    assert.ok(v2.wasRejected(), 'wasRejected() no lo sabe: el error no dira "Host key rejected"');
    assert.deepStrictEqual(pausas, ['prompt', 'settled'], 'el timeout de la conexion no se pausa/reanuda');
  });

  await check('K12 una conexion en cola tras otro dialogo del mismo host:port se cancela: no pregunta ni escribe al llegarle el turno', async () => {
    assert.ok(!sinKeygen, 'sin claves');
    await storeService.writeRaw('known-hosts', []);
    enviados.length = 0;
    const a = hostKeyService.verify('cola.example', 22, claves.ed.blob);
    const pa = await esperaPrompt(1);
    const pausas = [];
    const handle = { cancel: () => {} };
    const b = hostKeyService.verify('cola.example', 22, claves.ed2.blob, {
      handle, onPrompt: () => pausas.push('prompt'), onSettled: () => pausas.push('settled'),
    });
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(prompts().length, 1, 'la segunda clave abrio su dialogo sin esperar al primero');
    assert.deepStrictEqual(pausas, ['prompt'], 'en cola no pausa el timeout de su conexion');
    handle.cancel();                         // la conexion en cola muere
    const rb = await Promise.race([b, new Promise(r => setTimeout(() => r('colgada'), 200))]);
    assert.strictEqual(rb, false, `cancelar en cola no la resolvio (${rb})`);
    assert.deepStrictEqual(pausas, ['prompt', 'settled']);
    await bridge.ssh.respondHostKey(pa.requestId, true);
    assert.strictEqual(await a, true);
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(prompts().length, 1, 'la conexion muerta pregunto "changed" al llegarle el turno');
    const kh = (await storeService.getKnownHosts()).filter(e => e.host === 'cola.example');
    assert.deepStrictEqual(kh.map(e => e.fingerprint), [claves.ed.lf], 'la conexion muerta toco el almacen');

    // Una en cola que sigue viva: al llegarle el turno se decide contra el almacen
    enviados.length = 0;
    const c = hostKeyService.verify('cola2.example', 22, claves.ed.blob);
    const pc = await esperaPrompt(1);
    const d = hostKeyService.verify('cola2.example', 22, claves.ed2.blob, { handle: { cancel: () => {} } });
    await bridge.ssh.respondHostKey(pc.requestId, true);
    const pd = await esperaPrompt(2);
    assert.strictEqual(pd.reason, 'changed');
    await bridge.ssh.respondHostKey(pd.requestId, false);
    assert.deepStrictEqual(await Promise.all([c, d]), [true, false]);
    await storeService.writeRaw('known-hosts', []);
  });

  await check('K14a clave de un TIPO nuevo para un host:port conocido: "new-key-type" con las huellas guardadas; aceptar AGREGA', async () => {
    assert.ok(!sinKeygen, 'sin claves');
    await storeService.writeRaw('known-hosts', []);
    await storeService.saveKnownHost({ host: 'tipo.example', port: 22, keyType: claves.ed.type, key: claves.ed.b64, fingerprint: claves.ed.lf });
    enviados.length = 0;
    const v = hostKeyService.verify('tipo.example', 22, claves.ec.blob);
    const p = await esperaPrompt(1);
    assert.strictEqual(p.reason, 'new-key-type', `un tipo nuevo salio como "${p.reason}" (dialogo rutinario)`);
    assert.deepStrictEqual(p.knownFingerprints, [{ keyType: 'ssh-ed25519', fingerprint: claves.ed.lf }]);
    assert.strictEqual(p.fingerprint, claves.ec.lf);
    await bridge.ssh.respondHostKey(p.requestId, true);
    assert.strictEqual(await v, true);
    const tras = (await storeService.getKnownHosts()).map(e => e.fingerprint).sort();
    assert.deepStrictEqual(tras, [claves.ed.lf, claves.ec.lf].sort(), 'aceptar un tipo nuevo borro los otros');
    enviados.length = 0;
    assert.strictEqual(await hostKeyService.verify('tipo.example', 22, claves.ec.blob), true);
    assert.strictEqual(await hostKeyService.verify('tipo.example', 22, claves.ed.blob), true);
    assert.strictEqual(enviados.length, 0);
    // Nada guardado para el host:port: sigue siendo "unknown", sin campos de otro caso
    const w = hostKeyService.verify('nuevo.example', 22, claves.ec.blob);
    const q = await esperaPrompt(1);
    assert.strictEqual(q.reason, 'unknown');
    assert.ok(!('knownFingerprints' in q) && !('knownTypes' in q));
    await bridge.ssh.respondHostKey(q.requestId, false);
    assert.strictEqual(await w, false);
    await storeService.writeRaw('known-hosts', []);
  });

  hostKeyService.setMainWindow(ventanaOriginal);
  await storeService.writeRaw('known-hosts', []);

  await check('K9 historial: abre, cierra, sin secretos, tope de 1000 y cierre sincrono al salir', async () => {
    await storeService.writeRaw('connection-logs', []);
    await storeService.writeRaw('hosts', [{ id: 'h-log', label: 'Guardado', hostname: 'g.example', port: 22, username: 'derek' }]);
    const a = logService.start({ type: 'ssh', hostId: 'h-log', label: 'Guardado', hostname: 'g.example', port: 22, username: 'derek', password: SECRET });
    const b = logService.start({ type: 'ssh', hostId: 'tirado-quick-connect', label: 'x@y', hostname: 'y.example', port: 2222, username: 'x' });
    const c = logService.start({ type: 'local' });
    await logService.end(a);
    await logService.end(a);            // idempotente
    await logService.setOs(b, 'debian');
    let lista = await bridge.logs.list();
    const porId = Object.fromEntries(lista.map(e => [e.id, e]));
    assert.ok(porId[a].endedAt && porId[a].startedAt <= porId[a].endedAt, 'no quedo la hora de fin');
    assert.strictEqual(porId[a].hostId, 'h-log');
    assert.strictEqual(porId[b].hostId, null, 'un host que no esta guardado no puede llevar hostId');
    assert.strictEqual(porId[b].os, 'debian');
    assert.strictEqual(porId[c].label, 'Local Terminal');
    assert.strictEqual(porId[c].type, 'local');
    assert.ok(!('hostname' in porId[c]));
    assert.ok(porId[a].deviceName, 'sin nombre de dispositivo');
    assert.ok(!JSON.stringify(lista).includes(SECRET), 'la contrasena acabo en el historial');
    const permitidos = new Set(['id', 'type', 'hostId', 'label', 'hostname', 'port', 'username', 'os', 'email', 'deviceName', 'startedAt', 'endedAt', 'updatedAt']);
    for (const e of lista) for (const k of Object.keys(e)) assert.ok(permitidos.has(k), `campo inesperado en el historial: ${k}`);

    // Salir: lo abierto se cierra sin esperar a nada
    assert.strictEqual(logService.closeAllSync(), 2);
    lista = JSON.parse(fs.readFileSync(path.join(currentUserData, 'data', 'connection-logs.json'), 'utf-8'));
    assert.ok(lista.every(e => e.endedAt), 'quedaron sesiones abiertas tras before-quit');
    logService._closedForQuit = false;

    // Tope: 1000, se cae lo mas viejo
    const muchas = Array.from({ length: 1003 }, (_, i) => ({ id: `v${i}`, type: 'local', label: 'Local Terminal', startedAt: new Date(i * 1000).toISOString() }));
    await storeService.writeRaw('connection-logs', muchas.slice(0, 1000));
    for (const e of muchas.slice(1000)) await storeService.addConnectionLog(e, logService.MAX_ENTRIES);
    lista = await bridge.logs.list();
    assert.strictEqual(lista.length, 1000);
    assert.strictEqual(lista[0].id, 'v3', 'no se cayo lo mas viejo');
    assert.strictEqual(lista[999].id, 'v1002');

    await bridge.logs.clear();
    assert.deepStrictEqual(await bridge.logs.list(), []);
    await storeService.writeRaw('hosts', []);
  });

  await check('K11 de punta a punta contra un servidor ssh2 local: rechazar corta, aceptar conecta, el timeout se pausa', async () => {
    assert.ok(!sinKeygen, 'sin claves');
    const { Server } = require('ssh2');
    const sshService = require(path.join(ROOT, 'electron', 'services', 'ssh-service.js'));
    const servidor = new Server({ hostKeys: [fs.readFileSync(claves.ed.file.replace(/\.pub$/, ''))] }, (cliente) => {
      cliente.on('authentication', ctx => ctx.accept());
      cliente.on('error', () => {});
      cliente.on('ready', () => {
        cliente.on('session', (aceptar) => {
          const sesion = aceptar();
          sesion.on('pty', (ok) => ok && ok());
          sesion.on('shell', (ok) => { const st = ok(); st.write('hola\r\n'); });
          sesion.on('exec', (ok) => { const st = ok(); st.exit(0); st.end(); });
        });
      });
    });
    await new Promise(r => servidor.listen(0, '127.0.0.1', r));
    const puerto = servidor.address().port;

    // Contesta sola cada aviso, tras `demora` ms, con `respuesta`.
    let respuesta = false;
    let demora = 20;
    const vistos = [];
    hostKeyService.setMainWindow({
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: (canal, datos) => {
          if (canal !== 'ssh:host-key-prompt') return;
          vistos.push(datos);
          setTimeout(() => hostKeyService.respond(datos.requestId, respuesta), demora);
        },
      },
    });
    await storeService.writeRaw('known-hosts', []);
    await storeService.writeRaw('connection-logs', []);
    const cfg = { host: '127.0.0.1', port: puerto, username: 'derek', password: SECRET, label: 'local ssh2', timeout: 300 };
    try {
      await assert.rejects(sshService.connect(cfg), /Host key rejected/, 'rechazar la clave no dio "Host key rejected"');
      assert.strictEqual(vistos.length, 1);
      assert.strictEqual(vistos[0].fingerprint, claves.ed.lf, 'la huella del aviso no es la del servidor');
      assert.strictEqual((await storeService.getKnownHosts()).length, 0);

      // Acepta tarde (600 ms > timeout de 300 ms): la espera del usuario no cuenta.
      respuesta = true;
      demora = 600;
      const sessionId = await sshService.connect(cfg);
      assert.ok(sshService.isConnected(sessionId), 'aceptada pero sin sesion');
      assert.strictEqual(vistos.length, 2);
      const kh = await storeService.getKnownHosts();
      assert.deepStrictEqual(kh.map(e => [e.host, e.port, e.fingerprint]), [['127.0.0.1', puerto, claves.ed.lf]]);
      await sshService.disconnect(sessionId);

      // Ya conocida: conecta sin preguntar
      const otra = await sshService.connect(cfg);
      assert.strictEqual(vistos.length, 2, 'con la clave guardada volvio a preguntar');
      await sshService.disconnect(otra);
      await new Promise(r => setTimeout(r, 100));
      const logs = await storeService.getConnectionLogs();
      assert.strictEqual(logs.length, 2, `el historial tiene ${logs.length} entradas, esperaba 2 (la rechazada no cuenta)`);
      assert.ok(logs.every(e => e.endedAt && e.type === 'ssh' && e.port === puerto && e.username === 'derek'));
      assert.ok(!JSON.stringify(logs).includes(SECRET), 'la contrasena acabo en el historial');
    } finally {
      await sshService.disconnectAll();
      servidor.close();
      hostKeyService.setMainWindow(ventanaOriginal);
      await storeService.writeRaw('known-hosts', []);
      await storeService.writeRaw('connection-logs', []);
    }
  });

  await check('K13 el servidor corta con el dialogo abierto: falla ya, con la causa real (no "timed out" al rearmar el timeout)', async () => {
    assert.ok(!sinKeygen, 'sin claves');
    const { Server } = require('ssh2');
    const sshService = require(path.join(ROOT, 'electron', 'services', 'ssh-service.js'));
    const lados = [];
    const servidor = new Server({ hostKeys: [fs.readFileSync(claves.ed.file.replace(/\.pub$/, ''))] }, (cliente) => {
      lados.push(cliente);
      cliente.on('error', () => {});
    });
    await new Promise(r => servidor.listen(0, '127.0.0.1', r));
    const puerto = servidor.address().port;
    const vistos = [];
    const cerrados = [];
    hostKeyService.setMainWindow({
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: (canal, datos) => {
          if (canal === 'ssh:host-key-prompt') {
            vistos.push(datos);
            // Mientras el usuario lee: el servidor tira el socket
            setTimeout(() => lados.at(-1)._sock.destroy(), 20);
          }
          if (canal === 'ssh:host-key-prompt-cancel') cerrados.push(datos);
        },
      },
    });
    await storeService.writeRaw('known-hosts', []);
    try {
      const t0 = Date.now();
      const err = await Promise.race([
        sshService.connect({ host: '127.0.0.1', port: puerto, username: 'derek', password: SECRET, label: 'corta', timeout: 1500 })
          .then(() => null, e => e),
        new Promise(r => setTimeout(() => r(new Error('colgada: connect no se resolvio nunca')), 4000)),
      ]);
      const ms = Date.now() - t0;
      assert.ok(err, 'conecto con el socket cerrado');
      assert.ok(!/colgada/.test(err.message), err.message);
      assert.strictEqual(vistos.length, 1, 'no llego a preguntar');
      assert.ok(!/timed out/i.test(err.message), `causa equivocada: ${err.message}`);
      assert.match(err.message, /closed|reset/i);
      assert.ok(ms < 1000, `tardo ${ms} ms en fallar (esperaba el timeout rearmado)`);
      assert.deepStrictEqual(cerrados.map(c => c.requestId), [vistos[0].requestId], 'el dialogo no se cerro');
      assert.strictEqual(await hostKeyService.respond(vistos[0].requestId, true), false, 'una respuesta tardia valio');
      assert.strictEqual((await storeService.getKnownHosts()).length, 0, 'la conexion muerta guardo su clave');
    } finally {
      servidor.close();
      hostKeyService.setMainWindow(ventanaOriginal);
    }
  });

  await check('K14b se piden primero los tipos ya conocidos (serverHostKey): un servidor con ed25519+ecdsa conocido por ecdsa no pregunta (ssh y port forward)', async () => {
    assert.ok(!sinKeygen, 'sin claves');
    const { DEFAULT_SERVER_HOST_KEY: DEF, SUPPORTED_SERVER_HOST_KEY: SUP } = require('ssh2/lib/protocol/constants');
    const e = (keyType) => ({ host: 'a.example', port: 22, keyType });
    assert.strictEqual(kh.hostKeyAlgorithms([], 'a.example', 22, DEF, SUP), null, 'sin nada conocido no hay que tocar la lista');
    assert.strictEqual(kh.hostKeyAlgorithms([e('sk-ssh-ed25519@openssh.com')], 'a.example', 22, DEF, SUP), null);
    const ec = kh.hostKeyAlgorithms([e('ecdsa-sha2-nistp256')], 'A.example', 22, DEF, SUP);
    assert.strictEqual(ec[0], 'ecdsa-sha2-nistp256');
    assert.deepStrictEqual(ec.slice().sort(), DEF.slice().sort(), 'la lista no conserva el resto de algoritmos');
    const rsa = kh.hostKeyAlgorithms([e('ssh-rsa'), e('ssh-ed25519')], 'a.example', 22, DEF, SUP);
    assert.deepStrictEqual(rsa.slice(0, 4), ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa', 'ssh-ed25519']);
    assert.ok(rsa.every(a => SUP.includes(a)), 'nombre que ssh2 no admite');
    assert.strictEqual(kh.hostKeyAlgorithms([e('ssh-rsa')], 'a.example', 2222, DEF, SUP), null, 'otro puerto es otro host');

    const { Server } = require('ssh2');
    const sshService = require(path.join(ROOT, 'electron', 'services', 'ssh-service.js'));
    const pf = require(path.join(ROOT, 'electron', 'services', 'port-forward-service.js'));
    const privada = n => fs.readFileSync(claves[n].file.replace(/\.pub$/, ''));
    const servidor = new Server({ hostKeys: [privada('ed'), privada('ec')] }, (cliente) => {
      cliente.on('error', () => {});
      cliente.on('authentication', ctx => ctx.accept());
      cliente.on('ready', () => {
        cliente.on('session', (aceptar) => {
          const sesion = aceptar();
          sesion.on('pty', (ok) => ok && ok());
          sesion.on('shell', (ok) => { ok(); });
          sesion.on('exec', (ok) => { const st = ok(); st.exit(0); st.end(); });
        });
      });
    });
    await new Promise(r => servidor.listen(0, '127.0.0.1', r));
    const puerto = servidor.address().port;
    const vistos = [];
    hostKeyService.setMainWindow({
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: (canal, datos) => {
          if (canal !== 'ssh:host-key-prompt') return;
          vistos.push(datos);
          setTimeout(() => hostKeyService.respond(datos.requestId, false), 5);
        },
      },
    });
    await storeService.writeRaw('known-hosts', []);
    await storeService.saveKnownHost({ host: '127.0.0.1', port: puerto, keyType: claves.ec.type, key: claves.ec.b64, fingerprint: claves.ec.lf });
    const agente = process.env.SSH_AUTH_SOCK;
    delete process.env.SSH_AUTH_SOCK;
    try {
      const id = await sshService.connect({ host: '127.0.0.1', port: puerto, username: 'derek', password: SECRET, label: 'dos claves', timeout: 3000 });
      assert.deepStrictEqual(vistos.map(v => v.reason), [], 'ssh-service: el servidor presento un tipo que no conocemos');
      await sshService.disconnect(id);
      const cliente = await pf._createSSHClient({ host: '127.0.0.1', port: puerto, username: 'derek', password: SECRET, label: 'dos claves', timeout: 3000 });
      assert.deepStrictEqual(vistos.map(v => v.reason), [], 'port forward: el servidor presento un tipo que no conocemos');
      cliente.end();
    } finally {
      if (agente !== undefined) process.env.SSH_AUTH_SOCK = agente;
      await sshService.disconnectAll();
      servidor.close();
      hostKeyService.setMainWindow(ventanaOriginal);
      await storeService.writeRaw('known-hosts', []);
      await new Promise(r => setTimeout(r, 50));
      await storeService.writeRaw('connection-logs', []);
    }
  });

  await check('K15 OS detectado: main cambia SOLO `os` sobre lo que hay en disco (bajo lock), no-op si no cambia, nunca en un host sellado', async () => {
    const syncService = require(path.join(ROOT, 'electron', 'services', 'sync-service.js'));
    const hostsJson = path.join(currentUserData, 'data', 'hosts.json');
    const SELLADO = { id: 'h-os-sellado', label: 'Sellado', hostname: 's.example', username: 'x', authType: 'password' };
    await storeService.writeRaw('hosts', [{ id: 'h-os', label: 'Viejo', hostname: 'o.example', username: 'derek', authType: 'password', password: 'vieja' }, SELLADO]);
    // Un pull de sync reescribe hosts.json; la copia del renderer sigue siendo la vieja
    await storeService.writeRaw('hosts', [{ id: 'h-os', label: 'Nuevo', hostname: 'o.example', username: 'derek', authType: 'password', password: 'nueva' }, SELLADO]);
    const r = await bridge.store.setHostOs('h-os', 'debian');
    assert.ok(r && r.id === 'h-os' && r.os === 'debian', 'no devolvio el host actualizado');
    const enDisco = JSON.parse(fs.readFileSync(hostsJson, 'utf-8')).find(h => h.id === 'h-os');
    assert.strictEqual(enDisco.password, 'nueva', 'el guardado del OS piso la contrasena recien bajada');
    assert.strictEqual(enDisco.label, 'Nuevo');
    assert.strictEqual(enDisco.os, 'debian');
    assert.ok(enDisco.updatedAt, 'sin updatedAt: sync no lo veria como edicion');
    const antes = fs.readFileSync(hostsJson, 'utf-8');
    assert.strictEqual(await bridge.store.setHostOs('h-os', 'debian'), null, 'mismo os: no es no-op');
    assert.strictEqual(await bridge.store.setHostOs('no-existe', 'debian'), null, 'quick connect (id tirado) no es no-op');
    await syncService._load();
    const previo = syncService.state.undecryptable;
    syncService.state.undecryptable = { 'hosts/h-os-sellado': true };
    try {
      assert.strictEqual(await bridge.store.setHostOs('h-os-sellado', 'ubuntu'), null, 'escribio en un host sellado');
    } finally {
      syncService.state.undecryptable = previo;
    }
    assert.strictEqual(fs.readFileSync(hostsJson, 'utf-8'), antes, 'hosts.json cambio sin motivo (mismo os o sellado)');
    const ctx = fs.readFileSync(path.join(ROOT, 'src', 'contexts', 'AppContext.jsx'), 'utf-8');
    assert.ok(/store\.setHostOs\(hostId, os\)/.test(ctx), 'el renderer no usa store.setHostOs');
    assert.ok(!/saveHost\(\{\s*\.\.\.fresh,\s*os\s*\}\)/.test(ctx), 'el renderer sigue guardando el host entero con el os');
    await storeService.writeRaw('hosts', []);
  });

  await check('K16 salir: el cierre del historial espera a lo que esta en vuelo, va bajo el lock y tiene tope duro', async () => {
    const logsJson = path.join(currentUserData, 'data', 'connection-logs.json');
    await storeService.writeRaw('connection-logs', []);
    logService._closedForQuit = false;
    const a = logService.start({ type: 'local' });
    await logService._after(a);                       // A ya en disco, abierta
    const b = logService.start({ type: 'ssh', hostname: 'b.example', port: 22, username: 'x', label: 'b' });   // B en vuelo
    const n = await logService.closeAllForQuit(2000);
    await new Promise(r => setTimeout(r, 50));
    const porId = Object.fromEntries(JSON.parse(fs.readFileSync(logsJson, 'utf-8')).map(e => [e.id, e]));
    assert.ok(porId[a] && porId[a].endedAt, 'A se quedo sin hora de fin');
    assert.ok(porId[b], 'la entrada en vuelo se perdio');
    assert.ok(porId[b].endedAt, 'la entrada en vuelo al salir se quedo sin hora de fin');
    assert.strictEqual(n, 2);

    // Con el lock tomado por otro (una escritura colgada), salir no se cuelga
    logService._closedForQuit = false;
    const c = logService.start({ type: 'local' });
    await logService._after(c);
    await storeService._acquireLock('connection-logs');
    const t0 = Date.now();
    try {
      await logService.closeAllForQuit(200);
    } finally {
      storeService._releaseLock('connection-logs');
    }
    assert.ok(Date.now() - t0 < 1000, `salir espero ${Date.now() - t0} ms al lock`);
    assert.ok(JSON.parse(fs.readFileSync(logsJson, 'utf-8')).find(e => e.id === c).endedAt, 'tras el tope no se estampo');

    // main.js retiene el primer quit (preventDefault), una sola vez, y usa closeAllForQuit
    const mainSrc = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf-8');
    const bq = mainSrc.slice(mainSrc.indexOf("app.on('before-quit'"));
    assert.ok(/if \(quitCleanupDone\) return;/.test(bq) && /quitCleanupDone = true;/.test(bq), 'before-quit sin guarda: bucle de quit');
    assert.ok(/event\.preventDefault\(\)/.test(bq) && /closeAllForQuit\(/.test(bq) && /app\.quit\(\)/.test(bq), 'before-quit no espera al historial');
    logService._closedForQuit = false;
    await storeService.writeRaw('connection-logs', []);
  });

  await check('K10 known_hosts (cifrada) y connection_logs se sincronizan, en los dos lados', () => {
    const src = fs.readFileSync(path.join(ROOT, 'electron', 'services', 'sync-service.js'), 'utf-8');
    assert.ok(/known_hosts: 'known-hosts'/.test(src), 'sync-service no mapea known_hosts');
    assert.ok(/connection_logs: 'connection-logs'/.test(src), 'sync-service no mapea connection_logs');
    assert.ok(/ENCRYPTED_COLLECTIONS = new Set\(\[[^\]]*'known_hosts'/.test(src), 'known_hosts no va cifrada por fila');
    for (const col of ['known_hosts', 'connection_logs']) {
      assert.ok(COLECCIONES_SERVIDOR.has(col), `el servidor no admite ${col}`);
    }
  });

  fs.rmSync(keyDir, { recursive: true, force: true });
}

// ─── P. Port forwarding ─────────────────────────────────────

/**
 * Reglas con el modelo nuevo (migracion desde la forma vieja), start/stop por
 * id de regla, y tuneles DE VERDAD contra un ssh2.Server local: -L y -D (SOCKS5
 * CONNECT) hasta un servidor eco TCP, y -R con el servidor ssh abriendo el
 * puerto. Las credenciales las resuelve main desde el hostId: el renderer
 * nunca las manda.
 */
async function seccionPortForward() {
  const net = require('net');
  const { Server, utils } = require('ssh2');
  const pf = require(path.join(ROOT, 'electron', 'services', 'port-forward-service.js'));
  const hostKeyService = require(path.join(ROOT, 'electron', 'services', 'host-key-service.js'));
  const storeService = require(path.join(ROOT, 'electron', 'services', 'store-service.js'));
  const syncService = require(path.join(ROOT, 'electron', 'services', 'sync-service.js'));
  const PF_PASS = 'contrasena-del-tunel-no-debe-salir';

  const puertoLibre = () => new Promise((res, rej) => {
    const s = net.createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
  // Lee exactamente n bytes de un socket (acumulando), con tope de tiempo.
  const lector = (sock) => {
    let buf = Buffer.alloc(0);
    let espera = null;
    sock.on('data', (d) => { buf = Buffer.concat([buf, d]); if (espera) espera(); });
    return (n, ms = 3000) => new Promise((res, rej) => {
      const t = setTimeout(() => { espera = null; rej(new Error(`esperaba ${n} bytes, llegaron ${buf.length}`)); }, ms);
      const mira = () => {
        if (buf.length < n) return;
        clearTimeout(t);
        espera = null;
        const out = buf.subarray(0, n);
        buf = buf.subarray(n);
        res(out);
      };
      espera = mira;
      mira();
    });
  };
  const conecta = (port) => new Promise((res, rej) => {
    const c = net.connect(port, '127.0.0.1');
    c.once('connect', () => res(c));
    c.once('error', rej);
  });
  const eco = async (port, texto) => {
    const c = await conecta(port);
    const leer = lector(c);
    c.write(texto);
    const vuelta = (await leer(Buffer.byteLength(texto))).toString();
    c.destroy();
    return vuelta;
  };

  // Servidor eco (el "db:5432" del otro lado del tunel)
  const servidorEco = net.createServer(s => { s.on('error', () => {}); s.pipe(s); });
  await new Promise(r => servidorEco.listen(0, '127.0.0.1', r));
  const puertoEco = servidorEco.address().port;

  // Servidor ssh2 con password + clave publica y reenvio -L/-D (direct-tcpip) y -R (tcpip-forward)
  const clave = utils.generateKeyPairSync('ed25519');
  const pubPermitida = utils.parseKey(clave.public);
  const hostKey = utils.generateKeyPairSync('ed25519').private;
  let conexionesSsh = 0;
  const escuchasRemotas = [];
  const clientesSsh = [];
  const servidor = new Server({ hostKeys: [hostKey] }, (cliente) => {
    conexionesSsh++;
    clientesSsh.push(cliente);
    cliente.on('error', () => {});
    cliente.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.password === PF_PASS) return ctx.accept();
      if (ctx.method === 'publickey' && ctx.key.algo === pubPermitida.type
          && ctx.key.data.equals(pubPermitida.getPublicSSH())) {
        if (!ctx.signature) return ctx.accept();
        if (pubPermitida.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true) return ctx.accept();
      }
      ctx.reject(['password', 'publickey']);
    });
    cliente.on('ready', () => {
      cliente.on('tcpip', (accept, reject, info) => {
        const sock = net.connect(info.destPort, info.destIP);
        sock.once('connect', () => { const ch = accept(); ch.pipe(sock).pipe(ch); ch.on('error', () => {}); });
        sock.once('error', () => reject());
      });
      cliente.on('request', (accept, reject, name, info) => {
        if (name === 'tcpip-forward') {
          const l = net.createServer((sock) => {
            sock.on('error', () => {});
            cliente.forwardOut(info.bindAddr, info.bindPort, sock.remoteAddress, sock.remotePort, (err, ch) => {
              if (err) return sock.destroy();
              sock.pipe(ch).pipe(sock);
              ch.on('error', () => {});
            });
          });
          l.once('error', () => reject && reject());
          l.listen(info.bindPort, info.bindAddr, () => { escuchasRemotas.push(l); accept && accept(); });
        } else if (name === 'cancel-tcpip-forward') {
          for (const l of escuchasRemotas.splice(0)) l.close();
          accept && accept();
        } else if (reject) {
          reject();
        }
      });
    });
  });
  await new Promise(r => servidor.listen(0, '127.0.0.1', r));
  const puertoSsh = servidor.address().port;

  // Acepta sola la clave de host (lo de K11 ya prueba el dialogo)
  const ventanaHk = hostKeyService.mainWindow;
  hostKeyService.setMainWindow({
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (canal, datos) => { if (canal === 'ssh:host-key-prompt') setTimeout(() => hostKeyService.respond(datos.requestId, true), 5); },
    },
  });
  // Recoge los push de estado
  const eventos = [];
  const ventanaPf = pf.mainWindow;
  pf.setMainWindow({
    isDestroyed: () => false,
    webContents: { send: (canal, datos) => { if (canal === 'port-forward:status') eventos.push(datos); } },
  });
  const agente = process.env.SSH_AUTH_SOCK;
  delete process.env.SSH_AUTH_SOCK;

  const HOST_PASS = { id: 'h-pf', label: 'Tunel', hostname: '127.0.0.1', port: puertoSsh, username: 'derek', authType: 'password', password: PF_PASS };
  const HOST_KEY = { id: 'h-pf-key', label: 'Tunel con clave', hostname: '127.0.0.1', port: puertoSsh, username: 'derek', authType: 'key', keyId: 'k-pf' };
  const HOST_SELLADO = { id: 'h-sellado', label: 'Sellado', hostname: '127.0.0.1', port: puertoSsh, username: 'derek', authType: 'password' };
  const HOST_SIN = { id: 'h-sin', label: 'Sin contrasena', hostname: '127.0.0.1', port: puertoSsh, username: 'derek', authType: 'password' };
  await storeService.writeRaw('hosts', [HOST_PASS, HOST_KEY, HOST_SELLADO, HOST_SIN]);
  await storeService.writeRaw('keys', [{ id: 'k-pf', label: 'pf', privateKey: clave.private }]);
  await storeService.writeRaw('known-hosts', []);
  const estados = (id) => eventos.filter(e => e.ruleId === id).map(e => e.state);

  try {
    await check('P1 reglas viejas migran al leer (sourcePort -> localPort, sin hostId, sin active) y guardar quita active', async () => {
      const viejas = [
        { id: 'old-1', label: 'DB', type: 'local', sourcePort: 8080, destHost: 'db', destPort: 5432, active: true, sessionId: 'abc' },
        { id: 'old-2', label: '', type: 'dynamic', sourcePort: '1080', destHost: 'localhost', active: false },
        null,
        { id: 'old-3', type: 'raro', sourcePort: 99999 },
      ];
      await storeService.writeRaw('port-forwards', viejas);
      const antes = fs.readFileSync(path.join(currentUserData, 'data', 'port-forwards.json'), 'utf-8');
      const lista = await bridge.store.getPortForwards();
      assert.strictEqual(lista.length, 3, 'una entrada basura no se descarto');
      assert.deepStrictEqual(lista[0], { id: 'old-1', label: 'DB', type: 'local', hostId: null, bindAddress: '127.0.0.1', localPort: 8080, destHost: 'db', destPort: 5432 });
      assert.deepStrictEqual(lista[1], { id: 'old-2', label: 'Dynamic forward', type: 'dynamic', hostId: null, bindAddress: '127.0.0.1', localPort: 1080, destHost: '', destPort: null });
      assert.strictEqual(lista[2].type, 'local', 'tipo desconocido no cae en local');
      assert.strictEqual(lista[2].localPort, null, 'un puerto fuera de rango no se anula');
      assert.strictEqual(fs.readFileSync(path.join(currentUserData, 'data', 'port-forwards.json'), 'utf-8'), antes,
        'leer reescribio el archivo (sync lo subiria todo como editado)');
      const guardada = await bridge.store.savePortForward({ id: 'old-1', hostId: 'h-pf', active: true });
      assert.ok(!('active' in guardada) && !('sourcePort' in guardada), 'guardar dejo active/sourcePort');
      const enDisco = JSON.parse(fs.readFileSync(path.join(currentUserData, 'data', 'port-forwards.json'), 'utf-8'))
        .find(r => r && r.id === 'old-1');
      assert.ok(!('active' in enDisco) && !('sessionId' in enDisco), 'active llego al disco');
      assert.strictEqual(enDisco.localPort, 8080);
      assert.strictEqual(enDisco.hostId, 'h-pf');
      const nueva = await bridge.store.savePortForward({ label: 'x', type: 'local', hostId: 'h-pf', localPort: 1, destHost: 'a', destPort: 2, active: true });
      assert.ok(nueva.id && nueva.createdAt && !('active' in nueva));
      await storeService.writeRaw('port-forwards', []);
    });

    await check('P2 -L de punta a punta: start(ruleId) -> running, eco por el tunel, 2o start no-op, stop(ruleId) cierra el puerto', async () => {
      const puerto = await puertoLibre();
      await storeService.writeRaw('port-forwards', [{ id: 'r-local', label: 'DB', type: 'local', hostId: 'h-pf', bindAddress: '127.0.0.1', localPort: puerto, destHost: '127.0.0.1', destPort: puertoEco }]);
      eventos.length = 0;
      const antes = conexionesSsh;
      const r = await bridge.portForward.start('r-local');
      assert.strictEqual(r.state, 'running');
      assert.strictEqual(r.boundPort, puerto);
      assert.deepStrictEqual(estados('r-local'), ['starting', 'running']);
      assert.deepStrictEqual((await bridge.portForward.status()).map(s => [s.ruleId, s.state]), [['r-local', 'running']]);
      assert.strictEqual(await eco(puerto, 'hola por el tunel -L'), 'hola por el tunel -L');
      assert.strictEqual(await eco(puerto, 'otra vez'), 'otra vez', 'la segunda conexion por el tunel no paso');

      const r2 = await bridge.portForward.start('r-local');
      assert.strictEqual(r2.state, 'running');
      assert.strictEqual(conexionesSsh, antes + 1, 'el segundo start abrio otra conexion ssh');
      assert.deepStrictEqual(estados('r-local'), ['starting', 'running'], 'el segundo start emitio estados');
      // Dos start a la vez: una sola conexion
      await bridge.portForward.stop('r-local');
      const [a, b] = await Promise.all([bridge.portForward.start('r-local'), bridge.portForward.start('r-local')]);
      assert.deepStrictEqual([a.state, b.state], ['running', 'running']);
      assert.strictEqual(conexionesSsh, antes + 2, 'dos start simultaneos abrieron dos conexiones');

      assert.strictEqual(await bridge.portForward.stop('r-local'), true);
      await assert.rejects(conecta(puerto), /ECONNREFUSED/, 'tras stop(ruleId) el puerto sigue escuchando');
      assert.deepStrictEqual(await bridge.portForward.status(), []);
      assert.strictEqual(estados('r-local').at(-1), 'stopped');
      assert.strictEqual(await bridge.portForward.stop('r-local'), false, 'parar dos veces no es no-op');
      assert.ok(!alRenderer.join('\n').includes(PF_PASS), 'la contrasena llego al renderer');
    });

    await check('P3 -D SOCKS5 CONNECT hasta el eco por el mismo servidor, con host de clave SSH (keyId)', async () => {
      const puerto = await puertoLibre();
      await storeService.writeRaw('port-forwards', [{ id: 'r-dyn', label: 'SOCKS', type: 'dynamic', hostId: 'h-pf-key', localPort: puerto }]);
      const r = await bridge.portForward.start('r-dyn');
      assert.strictEqual(r.state, 'running');
      const c = await conecta(puerto);
      const leer = lector(c);
      c.write(Buffer.from([0x05, 0x01, 0x00]));
      assert.deepStrictEqual([...(await leer(2))], [0x05, 0x00], 'saludo SOCKS5 incorrecto');
      c.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, puertoEco >> 8, puertoEco & 0xff]));
      const resp = await leer(10);
      assert.strictEqual(resp[1], 0x00, `CONNECT fallo con codigo ${resp[1]}`);
      c.write('por socks5');
      assert.strictEqual((await leer(10)).toString(), 'por socks5');
      c.destroy();
      // Nombre de dominio (ATYP 3) en un solo paquete con el saludo
      const d = await conecta(puerto);
      const leerD = lector(d);
      const nombre = Buffer.from('localhost');
      d.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x05, 0x01, 0x00, 0x03, nombre.length]), nombre, Buffer.from([puertoEco >> 8, puertoEco & 0xff])]));
      await leerD(2);
      assert.strictEqual((await leerD(10))[1], 0x00, 'CONNECT por nombre fallo');
      d.write('dominio');
      assert.strictEqual((await leerD(7)).toString(), 'dominio');
      d.destroy();
      await bridge.portForward.stop('r-dyn');
      await assert.rejects(conecta(puerto), /ECONNREFUSED/);
    });

    await check('P4 -R: el servidor abre el puerto y lo trae hasta el eco de este equipo; stop lo cierra alli', async () => {
      const puertoServidor = await puertoLibre();
      await storeService.writeRaw('port-forwards', [{ id: 'r-rem', label: 'Remoto', type: 'remote', hostId: 'h-pf', bindAddress: '127.0.0.1', localPort: puertoServidor, destHost: '127.0.0.1', destPort: puertoEco }]);
      const r = await bridge.portForward.start('r-rem');
      assert.strictEqual(r.state, 'running');
      assert.strictEqual(await eco(puertoServidor, 'de vuelta por -R'), 'de vuelta por -R');
      await bridge.portForward.stop('r-rem');
      await new Promise(res => setTimeout(res, 50));
      await assert.rejects(conecta(puertoServidor), /ECONNREFUSED/, 'el servidor sigue escuchando tras stop');
    });

    await check('P5 sin hostId / host sellado / sin contrasena / puerto ocupado: error claro, estado error, sin intentar ssh', async () => {
      const ocupado = net.createServer();
      await new Promise(r => ocupado.listen(0, '127.0.0.1', r));
      const puertoOcupado = ocupado.address().port;
      await storeService.writeRaw('port-forwards', [
        { id: 'e-sin-host', type: 'local', localPort: 18080, destHost: 'db', destPort: 5432 },
        { id: 'e-sellado', type: 'local', hostId: 'h-sellado', localPort: 18081, destHost: 'db', destPort: 5432 },
        { id: 'e-sin-pass', type: 'local', hostId: 'h-sin', localPort: 18082, destHost: 'db', destPort: 5432 },
        { id: 'e-borrado', type: 'local', hostId: 'h-no-existe', localPort: 18083, destHost: 'db', destPort: 5432 },
        { id: 'e-ocupado', type: 'local', hostId: 'h-pf', localPort: puertoOcupado, destHost: '127.0.0.1', destPort: puertoEco },
      ]);
      await syncService._load();
      const previo = syncService.state.undecryptable;
      syncService.state.undecryptable = { 'hosts/h-sellado': true };
      eventos.length = 0;
      const antes = conexionesSsh;
      try {
        await assert.rejects(bridge.portForward.start('e-sin-host'), /Choose a host/);
        await assert.rejects(bridge.portForward.start('e-sellado'), /saved on another computer and cannot be decrypted here/);
        await assert.rejects(bridge.portForward.start('e-sin-pass'), /has no saved password/);
        await assert.rejects(bridge.portForward.start('e-borrado'), /no longer exists/);
        await assert.rejects(bridge.portForward.start('no-hay-regla'), /no longer exists/);
        await assert.rejects(bridge.portForward.start({ type: 'local', host: 'x' }), /rule id/, 'la forma vieja (objeto) no se rechaza');
      } finally {
        syncService.state.undecryptable = previo;
      }
      assert.strictEqual(conexionesSsh, antes, 'intento conectar por ssh sin credenciales validas');
      await assert.rejects(bridge.portForward.start('e-ocupado'), /already in use/);
      await new Promise(r => setTimeout(r, 50));
      const st = Object.fromEntries((await bridge.portForward.status()).map(s => [s.ruleId, s]));
      assert.deepStrictEqual(Object.keys(st).sort(), ['e-borrado', 'e-ocupado', 'e-sellado', 'e-sin-host', 'e-sin-pass', 'no-hay-regla']);
      assert.ok(Object.values(st).every(s => s.state === 'error' && s.error), 'un fallo no quedo como error con mensaje');
      assert.ok(eventos.filter(e => e.state === 'error').every(e => e.error), 'push de error sin mensaje');
      assert.deepStrictEqual(estados('e-sellado'), ['starting', 'error']);
      // Parar un error lo limpia
      for (const id of Object.keys(st)) await bridge.portForward.stop(id);
      assert.deepStrictEqual(await bridge.portForward.status(), []);
      ocupado.close();
    });

    await check('P6 borrar una regla en marcha la para; un stop durante el arranque no deja el puerto abierto', async () => {
      const puerto = await puertoLibre();
      await storeService.writeRaw('port-forwards', [{ id: 'r-del', type: 'local', hostId: 'h-pf', localPort: puerto, destHost: '127.0.0.1', destPort: puertoEco }]);
      await bridge.portForward.start('r-del');
      assert.strictEqual(await bridge.store.deletePortForward('r-del'), true);
      await assert.rejects(conecta(puerto), /ECONNREFUSED/, 'borrar la regla dejo el tunel abierto');
      assert.deepStrictEqual(await bridge.portForward.status(), []);

      const puerto2 = await puertoLibre();
      await storeService.writeRaw('port-forwards', [{ id: 'r-cancel', type: 'local', hostId: 'h-pf', localPort: puerto2, destHost: '127.0.0.1', destPort: puertoEco }]);
      const arranque = bridge.portForward.start('r-cancel');
      await new Promise(r => setTimeout(r, 5));
      await bridge.portForward.stop('r-cancel');
      const fin = await arranque;
      assert.strictEqual(fin.state, 'stopped');
      await new Promise(r => setTimeout(r, 100));
      await assert.rejects(conecta(puerto2), /ECONNREFUSED/, 'un stop durante el arranque dejo el puerto escuchando');
      assert.deepStrictEqual(await bridge.portForward.status(), []);
    });

    await check('P8 si el servidor corta la conexion ssh con el tunel en marcha: estado error con mensaje y el puerto se cierra', async () => {
      const puerto = await puertoLibre();
      await storeService.writeRaw('port-forwards', [{ id: 'r-cae', type: 'local', hostId: 'h-pf', localPort: puerto, destHost: '127.0.0.1', destPort: puertoEco }]);
      eventos.length = 0;
      clientesSsh.length = 0;
      await bridge.portForward.start('r-cae');
      assert.strictEqual(clientesSsh.length, 1);
      clientesSsh[0].end();
      for (let i = 0; i < 100 && !estados('r-cae').includes('error'); i++) await new Promise(r => setTimeout(r, 10));
      const ultimo = eventos.filter(e => e.ruleId === 'r-cae').at(-1);
      assert.strictEqual(ultimo && ultimo.state, 'error', `tras el corte el estado es ${ultimo && ultimo.state}`);
      assert.match(ultimo.error, /closed|error/i);
      await new Promise(r => setTimeout(r, 50));
      await assert.rejects(conecta(puerto), /ECONNREFUSED/, 'el puerto sigue abierto con la conexion ssh muerta');
      const st = await bridge.portForward.status();
      assert.deepStrictEqual(st.map(x => [x.ruleId, x.state]), [['r-cae', 'error']]);
      await bridge.portForward.stop('r-cae');
    });

    await check('P9 si la conexion ssh muere entre ready y el listener: error y puerto cerrado, no "running" con un cliente muerto', async () => {
      const puerto = await puertoLibre();
      await storeService.writeRaw('port-forwards', [{ id: 'r-muere', type: 'local', hostId: 'h-pf', localPort: puerto, destHost: '127.0.0.1', destPort: puertoEco }]);
      eventos.length = 0;
      const real = pf._listenLocal;
      // El cliente muere justo antes de levantar el listener
      pf._listenLocal = function (entry, client, rule) {
        return new Promise((res) => { client.once('close', res); client.end(); })
          .then(() => real.call(this, entry, client, rule));
      };
      try {
        await assert.rejects(bridge.portForward.start('r-muere'), /closed|error/i, 'con el cliente muerto el tunel arranco');
      } finally {
        pf._listenLocal = real;
      }
      assert.deepStrictEqual(estados('r-muere'), ['starting', 'error']);
      await new Promise(r => setTimeout(r, 50));
      await assert.rejects(conecta(puerto), /ECONNREFUSED/, 'el listener quedo abierto');
      assert.deepStrictEqual((await bridge.portForward.status()).map(x => [x.ruleId, x.state]), [['r-muere', 'error']]);
      await bridge.portForward.stop('r-muere');
    });

    await check('P7 preload: port-forward:status con onStatus/removeStatusListener que solo quita el suyo', () => {
      const a = [], b = [];
      const lA = bridge.portForward.onStatus(d => a.push(d));
      const lB = bridge.portForward.onStatus(d => b.push(d));
      emit('port-forward:status', { ruleId: 'x', state: 'running' });
      bridge.portForward.removeStatusListener(lB);
      emit('port-forward:status', { ruleId: 'x', state: 'stopped' });
      assert.deepStrictEqual([a.length, b.length], [2, 1]);
      assert.deepStrictEqual(a[0], { ruleId: 'x', state: 'running' });
      bridge.portForward.removeStatusListener(lA);
    });
  } finally {
    await pf.stopAll();
    if (agente !== undefined) process.env.SSH_AUTH_SOCK = agente;
    pf.setMainWindow(ventanaPf);
    hostKeyService.setMainWindow(ventanaHk);
    for (const l of escuchasRemotas.splice(0)) l.close();
    servidor.close();
    servidorEco.close();
    await storeService.writeRaw('port-forwards', []);
    await storeService.writeRaw('hosts', []);
    await storeService.writeRaw('keys', []);
    await storeService.writeRaw('known-hosts', []);
  }
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

  // ── K. Known hosts + historial de conexiones ─────────────
  // Todo local (ninguna de las dos colecciones esta en sync-service). Se prueba
  // antes que el sync para que el almacen sea el del primer dispositivo.
  await seccionKnownHosts();

  // ── P. Port forwarding ────────────────────────────────────
  await seccionPortForward();

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

  // ── S. known_hosts (cifrada) y connection_logs se sincronizan ─────────────
  //
  // known_hosts va sellada por AUTENTICIDAD: si el servidor pudiera escribir
  // una fila que los equipos aceptan, plantaria una clave de host falsa en
  // todos. Por eso tambien sus lapidas van selladas.
  const knownHosts = require(path.join(ROOT, 'electron', 'services', 'known-hosts.js'));
  const hostKeyService = require(path.join(ROOT, 'electron', 'services', 'host-key-service.js'));
  const logService = require(path.join(ROOT, 'electron', 'services', 'connection-log-service.js'));
  const blobDe = relleno => {
    const tipo = Buffer.from('ssh-ed25519');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(tipo.length);
    const clen = Buffer.alloc(4);
    clen.writeUInt32BE(32);
    return Buffer.concat([len, tipo, clen, Buffer.alloc(32, relleno)]);
  };
  const aceptar = async (host, port, blob, opts) => {
    const info = knownHosts.keyInfo(blob);
    return storeService.saveKnownHost({ host, port, ...info }, opts);
  };
  const deHost = async host => (await storeService.readRaw('known-hosts')).filter(e => e.host === host);
  // Lo que no puede aparecer en ningun cuerpo que sube: host, clave, huella.
  const enClaro = (texto, host, blob) => {
    const info = knownHosts.keyInfo(blob);
    return [host, info.key, info.fingerprint, info.fingerprint.replace(/^SHA256:/, '')]
      .filter(x => texto.includes(x));
  };
  const flipByte = b64 => { const b = Buffer.from(b64, 'base64'); b[b.length - 1] ^= 0x55; return b.toString('base64'); };

  const KH = 'kh-secreto.example';
  const s = {};
  await nuevoServidor();
  await check('S1 un known host sube sellado: ni host, ni clave, ni huella en el cable', async () => {
    await usarDispositivo('SA');
    s.a = await aceptar(KH, 2222, blobDe(1));
    await syncService.setupPassphrase(PASS_S);
    clavesDerivadas.push(await cryptoService.getMasterKey());
    const fila = srv.rowFor('known_hosts', s.a.id);
    assert.ok(fila, 'el known host no subio');
    assert.strictEqual(fila.enc, true, 'known_hosts no subio cifrada por fila');
    assert.strictEqual(fila.payload, null);
    assert.deepStrictEqual(enClaro(srv.allBodies(), KH, blobDe(1)), [], 'el known host viajo en claro');
  });

  await check('S2 sin desbloquear: lo remoto no se aplica (cuenta como ilegible) y lo local no sube', async () => {
    await usarDispositivo('SB');
    s.b = await aceptar('solo-en-b.example', 22, blobDe(2));
    await syncService.syncNow();
    const status = await syncService.status();
    assert.strictEqual(status.unlocked, false);
    assert.ok(status.undecryptableIds.includes(`known_hosts/${s.a.id}`),
      `el known host de A no cuenta como ilegible: ${status.undecryptableIds}`);
    assert.strictEqual((await deHost(KH)).length, 0, 'B aplico un known host que no puede abrir');
    assert.strictEqual(srv.rowFor('known_hosts', s.b.id), null, 'B subio un known host sin estar desbloqueado');
    assert.ok(!srv.allBodies().includes('solo-en-b.example'), 'el known host de B salio en claro');
  });

  await check('S3 B desbloquea: baja y abre el de A, y sube el suyo sellado', async () => {
    await syncService.unlock(PASS_S);
    const deA = await deHost(KH);
    assert.strictEqual(deA.length, 1, 'B no tiene el known host de A');
    assert.strictEqual(deA[0].key, knownHosts.keyInfo(blobDe(1)).key);
    assert.strictEqual(deA[0].port, 2222);
    assert.strictEqual(await hostKeyService.verify(KH, 2222, blobDe(1)), true,
      'B no confia en la clave que acepto A');
    const filaB = srv.rowFor('known_hosts', s.b.id);
    assert.ok(filaB && filaB.enc === true, 'tras desbloquear, el known host de B no subio sellado');
    assert.deepStrictEqual((await syncService.status()).undecryptableIds.filter(x => x.startsWith('known_hosts/')), []);
  });

  await check('S4 lo que el servidor falsifique no toca la copia local (manipulado, reenviado, lapida en claro o ajena)', async () => {
    const original = srv.rowFor('known_hosts', s.a.id);
    const filaB = srv.rowFor('known_hosts', s.b.id);
    const intentos = [
      ['cifrado manipulado', { ...original, ciphertext: flipByte(original.ciphertext) }],
      ['cifrado de OTRA entrada bajo este id', { ...filaB, item_id: s.a.id }],
      ['lapida en claro', { collection: 'known_hosts', item_id: s.a.id, enc: false, payload: null, ciphertext: null, nonce: null, deleted: true, updated_at: '2030-01-01T00:00:00.000Z' }],
      ['lapida sellada con otra clave', {
        collection: 'known_hosts', item_id: s.a.id, enc: true, payload: null, deleted: true, updated_at: '2030-01-01T00:00:00.000Z',
        ...cryptoService.encryptWith(Buffer.alloc(32, 7), JSON.stringify({ id: s.a.id, deleted: true })),
      }],
      ['lapida sellada que es la fila viva', { ...original, deleted: true }],
    ];
    for (const [que, fila] of intentos) {
      srv.inject(fila);
      srv.reset();
      await silenciaErrores(() => syncService.syncNow());
      const local = await deHost(KH);
      assert.strictEqual(local.length, 1, `${que}: la entrada local desaparecio`);
      assert.strictEqual(local[0].id, s.a.id, `${que}: la entrada local cambio de id`);
      assert.strictEqual(local[0].key, knownHosts.keyInfo(blobDe(1)).key, `${que}: la clave local cambio`);
      assert.ok(!srv.syncPosts().some(b => b.includes(s.a.id)), `${que}: se reenvio la entrada desde aqui`);
    }
    assert.strictEqual(await hostKeyService.verify(KH, 2222, blobDe(1)), true);
  });

  // Dos equipos limpios en otro servidor para los conflictos y el historial.
  await nuevoServidor();
  const CONF = 'conflicto.example';
  const IGUAL = 'igual.example';
  const ventanaHk = hostKeyService.mainWindow;
  hostKeyService.setMainWindow(null);   // un aviso sin ventana RECHAZA: sin esperas de 120 s
  const turnos = async (...nombres) => {
    for (const n of nombres) { await usarDispositivo(n); await syncService.syncNow(); }
  };
  await check('S5 dos equipos aceptan claves distintas del mismo host:port: vale cualquiera, "changed" igual en los dos, y reemplazar borra ambas en todos', async () => {
    await usarDispositivo('SC');
    await syncService.setupPassphrase(PASS_S);
    await aceptar(CONF, 22, blobDe(3));
    await usarDispositivo('SD');
    await syncService.unlock(PASS_S);
    await aceptar(CONF, 22, blobDe(4));
    await turnos('SC', 'SD', 'SC');

    const previas = [];
    for (const n of ['SC', 'SD']) {
      await usarDispositivo(n);
      const mias = await deHost(CONF);
      assert.strictEqual(mias.length, 2, `${n} deberia tener las dos claves, tiene ${mias.length}`);
      assert.strictEqual(await hostKeyService.verify(CONF, 22, blobDe(3)), true, `${n}: rechaza la clave de SC`);
      assert.strictEqual(await hostKeyService.verify(CONF, 22, blobDe(4)), true, `${n}: rechaza la clave de SD`);
      const d = knownHosts.decide(await storeService.getKnownHosts(), CONF, 22, blobDe(5));
      assert.strictEqual(d.reason, 'changed', `${n}: una tercera clave no se presenta como cambiada`);
      previas.push(d.previousFingerprint);
      assert.strictEqual(await hostKeyService.verify(CONF, 22, blobDe(5)), false, `${n}: acepto una clave desconocida sin preguntar`);
    }
    assert.strictEqual(previas[0], previas[1], 'los dos equipos ensenan una "clave anterior" distinta');

    // SC acepta la nueva (lo que hace respond() con reason 'changed').
    await usarDispositivo('SC');
    await aceptar(CONF, 22, blobDe(5), { replaceAll: true });
    srv.reset();
    await syncService.syncNow();
    const lapidas = srv.syncPosts().flatMap(b => JSON.parse(b).records).filter(r => r.collection === 'known_hosts' && r.deleted);
    assert.strictEqual(lapidas.length, 2, `deberian salir 2 lapidas, salen ${lapidas.length}`);
    assert.ok(lapidas.every(r => r.enc === true && r.ciphertext && r.payload === null), 'una lapida de known_hosts salio sin sellar');
    await turnos('SD');
    const enD = await deHost(CONF);
    assert.deepStrictEqual(enD.map(e => e.key), [knownHosts.keyInfo(blobDe(5)).key], 'SD no se quedo solo con la clave nueva');
    assert.strictEqual(await hostKeyService.verify(CONF, 22, blobDe(3)), false, 'SD sigue confiando en la clave reemplazada');
  });

  await check('S6 la misma clave aceptada en dos equipos converge a una sola entrada (el id menor)', async () => {
    await usarDispositivo('SC');
    const c = await aceptar(IGUAL, 22, blobDe(6));
    await usarDispositivo('SD');
    const d = await aceptar(IGUAL, 22, blobDe(6));
    await turnos('SC', 'SD', 'SC', 'SD');
    const esperado = [c.id, d.id].sort()[0];
    for (const n of ['SC', 'SD']) {
      await usarDispositivo(n);
      assert.deepStrictEqual((await deHost(IGUAL)).map(e => e.id), [esperado], `${n} no convergio`);
    }
    const vivas = srv.rows.filter(r => r.record.collection === 'known_hosts' && !r.record.deleted
      && [c.id, d.id].includes(r.record.item_id));
    assert.deepStrictEqual(vivas.map(r => r.record.item_id), [esperado], 'en el servidor queda mas de una');
    const cable = srv.allBodies();
    for (const [h, b] of [[CONF, 3], [CONF, 4], [CONF, 5], [IGUAL, 6]]) {
      assert.deepStrictEqual(enClaro(cable, h, blobDe(b)), [], `algo de ${h} viajo en claro`);
    }
  });
  hostKeyService.setMainWindow(ventanaHk);

  await check('S7 historial: el inicio y el fin llegan al servidor, y otro equipo los ve', async () => {
    await usarDispositivo('SC');
    const id = logService.start({ type: 'ssh', label: 'Log', hostname: 'log.example', port: 22, username: 'derek' });
    await logService._after(id);
    await syncService.syncNow();
    let fila = srv.rowFor('connection_logs', id);
    assert.ok(fila && fila.enc === false && fila.payload.startedAt, 'el inicio no subio');
    assert.ok(!fila.payload.endedAt);
    await logService.end(id);
    await syncService.syncNow();
    fila = srv.rowFor('connection_logs', id);
    assert.ok(fila.payload.endedAt, 'el fin no subio (el hash no se movio)');
    await turnos('SD');
    const enD = (await storeService.readRaw('connection-logs')).find(e => e.id === id);
    assert.ok(enD && enD.endedAt === fila.payload.endedAt, 'SD no tiene la entrada cerrada');

    // Un re-pull desde 0 (instalar clave, actualizar la app) con el fin aun sin
    // subir: la copia vieja del servidor no puede pisar el fin local.
    await usarDispositivo('SC');
    const id2 = logService.start({ type: 'local' });
    await logService._after(id2);
    await syncService.syncNow();
    await logService.end(id2);
    syncService.state.cursor = 0;
    await syncService.syncNow();
    const local = (await storeService.readRaw('connection-logs')).find(e => e.id === id2);
    assert.ok(local && local.endedAt, 'el re-pull desde 0 borro la hora de fin local');
    assert.ok(srv.rowFor('connection_logs', id2).payload.endedAt, 'el fin no llego al servidor tras el re-pull');
  });

  await check('S9 cliente v1.10.0: ignora known_hosts/connection_logs sin error, y al actualizar se re-baja desde 0', async () => {
    // El sync-service publicado en v1.10.0 (commit del bump de version).
    const fuente = execFileSync('git', ['show', '5ecfa09:electron/services/sync-service.js'], { cwd: ROOT, encoding: 'utf-8' });
    assert.ok(/unknown collection from a newer server: ignore/.test(fuente), 'no es el sync-service esperado');
    const falso = path.join(ROOT, 'electron', 'services', 'sync-service.v1.10.0.js');   // no existe en disco
    const m = new Module(falso, module);
    m.filename = falso;
    m.paths = Module._nodeModulePaths(path.dirname(falso));
    m._compile(fuente, falso);
    const viejo = m.exports;
    assert.notStrictEqual(viejo, syncService);

    const dir = await usarDispositivo('SL');
    await silenciaErrores(() => viejo.syncNow());
    const st = await viejo.status();
    assert.strictEqual(st.error, null, `el cliente viejo da error: ${st.error}`);
    for (const f of ['known-hosts.json', 'connection-logs.json']) {
      assert.ok(!fs.existsSync(path.join(dir, 'data', f)), `el cliente viejo escribio ${f}`);
    }
    assert.ok(!st.undecryptableIds.some(x => /^(known_hosts|connection_logs)\//.test(x)),
      'el cliente viejo cuenta los known hosts como ilegibles');
    const maxNueva = Math.max(...srv.rows.filter(r => ['known_hosts', 'connection_logs'].includes(r.record.collection)).map(r => r.cursor));
    assert.ok(viejo.state.cursor >= maxNueva, 'la prueba no prueba: el cursor viejo no paso por encima de las filas nuevas');

    // Se actualiza la app en ese equipo: el cursor viejo no cubre las colecciones nuevas.
    syncService._loaded = false;
    syncService._chain = null;
    await syncService.syncNow();
    const logs = await storeService.readRaw('connection-logs');
    assert.ok(logs.length > 0, 'tras actualizar no bajo el historial que el cliente viejo salto');
    const st2 = await syncService.status();
    assert.ok(st2.undecryptableIds.some(x => x.startsWith('known_hosts/')),
      'tras actualizar, los known hosts (sin desbloquear) no cuentan como ilegibles');
    await syncService.unlock(PASS_S);
    assert.ok((await deHost(CONF)).length === 1 && (await deHost(IGUAL)).length === 1,
      'tras desbloquear no estan los known hosts que el cliente viejo salto');
  });

  // Servidor propio: con el historial de SC/SD delante, el primer pull ya pasa
  // del tope y el recorte (correcto) se lleva mas de una.
  await nuevoServidor();
  await check('S8 tope de 1000: cada entrada nueva cuesta una lapida en el mismo lote, no una rafaga', async () => {
    await usarDispositivo('SE');
    await cryptoService.setToken('token-SE');
    const viejas = Array.from({ length: 1000 }, (_, i) => ({
      id: `tope-${String(i).padStart(4, '0')}`, type: 'local', label: 'Local Terminal',
      startedAt: new Date(Date.UTC(2020, 0, 1) + i * 1000).toISOString(),
    }));
    await storeService.writeRaw('connection-logs', viejas);
    await syncService.syncNow();
    srv.reset();
    await storeService.addConnectionLog({ id: 'tope-nueva', type: 'local', label: 'Local Terminal', startedAt: new Date().toISOString() }, logService.MAX_ENTRIES);
    await syncService.syncNow();
    const posts = srv.syncPosts();
    const subidas = posts.flatMap(b => JSON.parse(b).records);
    assert.strictEqual(posts.length, 1, `el recorte hizo ${posts.length} peticiones`);
    assert.deepStrictEqual(subidas.map(r => [r.item_id, r.deleted]).sort(),
      [['tope-0000', true], ['tope-nueva', false]], `subio ${subidas.length} registros`);
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
