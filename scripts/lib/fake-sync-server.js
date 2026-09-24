/**
 * Servidor de sync falso para los arneses (scripts/check-main.js y
 * scripts/check-mobile.js). Se comporta como server/api: cursor, lapidas,
 * emparejamiento en dos pasos, y la lista blanca de colecciones leida del
 * fuente del servidor real.
 *
 * `onBody(raw)` recibe cada cuerpo crudo que llega (el arnes de escritorio lo
 * acumula en `cableTotal` para T8).
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');

/* La lista blanca del servidor REAL, leida de su fuente: el falso rechaza con
   400 lo mismo que el real, asi que olvidar una coleccion alli pone esto rojo. */
const COLECCIONES_SERVIDOR = (() => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'api', 'src', 'server.js'), 'utf-8');
  const m = src.match(/const COLLECTIONS = \[([^\]]*)\]/);
  if (!m) throw new Error('no encuentro COLLECTIONS en server/api/src/server.js');
  return new Set([...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]));
})();

/** Guarda lo que le suben tal cual y lo devuelve por cursor, como el real. */
function fakeServer({ onBody } = {}) {
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
  // authorizeUrl: lo que /auth/start devuelve para abrir en el navegador (el
  // arnes movil comprueba que llega a la pagina como native:open-url).
  // pollPending: /auth/poll contesta 202 siempre (login que nadie termina en
  // el navegador: el arnes movil cancela uno a medias).
  const hooks = { afterVaultPush: null, failSyncPost: false, failSyncGet: false, authorizeUrl: null, pollPending: false };

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
      if (raw) { bodies.push(raw); if (onBody) onBody(raw); }
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
        return json(200, { code: 'codigo-arnes', authorize_url: hooks.authorizeUrl });
      }
      if (req.method === 'GET' && url.pathname === '/auth/poll') {
        if (hooks.pollPending) return json(202, { status: 'pendiente' });
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

module.exports = { fakeServer, COLECCIONES_SERVIDOR };
