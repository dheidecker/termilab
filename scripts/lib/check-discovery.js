/**
 * Seccion PC del arnes del main (scripts/check-main.js): el selector de PC del
 * espejo web (electron/web/discovery.js, canal web:peers).
 * NUNCA toca la tailnet de verdad: TERMILAB_TAILSCALE_BIN apunta a un
 * tailscale falso que imprime el JSON de FAKE_DISC_JSON, y los "peers" son un
 * servidor HTTPS local con un certificado autofirmado (openssl, en un mkdtemp)
 * que se reparte por la cabecera Host. La confianza en ese certificado entra
 * por un https.Agent inyectado; sin el, la verificacion normal lo rechaza.
 *
 *  PC1  candidatos: offline, tagged, de otro usuario y compartidos fuera.
 *  PC2  un peer que responde Termilab: incluido (nombre del peer, o HostName).
 *  PC3  otra app, HTML, 403 o timeout: excluido; los filtrados ni se sondean.
 *  PC4  self marcado y primero, con el nombre y la version locales.
 *  PC5  cache: dentro del TTL no vuelve a llamar a tailscale ni a los peers;
 *       pasado el TTL, si; dos llamadas a la vez comparten una.
 *  PC6  verificacion TLS por defecto: sin el agente de prueba, el autofirmado no pasa.
 *  PC7  web:peers registrado, por el sobre, con el nombre de settings.remoteAccess.
 *
 * Solo esta seccion: TERMILAB_CHECK_ONLY=PC.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const FAKE = String.raw`
const fs = require('fs');
fs.appendFileSync(process.env.FAKE_DISC_LOG, JSON.stringify(process.argv.slice(2)) + '\n');
if (process.argv[2] === 'status') { process.stdout.write(fs.readFileSync(process.env.FAKE_DISC_JSON, 'utf-8')); process.exit(0); }
process.exit(1);
`;

const TN = 'tail-test.ts.net';
const N = (h) => `${h}.${TN}`;
const NAMES = ['self', 'pc-a', 'pc-b', 'other-app', 'html', 'forbidden', 'slow', 'offline', 'tagged', 'stranger', 'shared'];

function statusWith(peers) {
  const Peer = {};
  peers.forEach((p, i) => { Peer[`nodekey:${i}`] = { HostName: p.host, DNSName: `${N(p.host)}.`, UserID: 42, Online: true, Tags: null, ...p.extra }; });
  return {
    BackendState: 'Running',
    Self: { UserID: 42, HostName: 'self-host', DNSName: `${N('self')}.`, Tags: null },
    User: { '42': { ID: 42, LoginName: 'derek@example.com' }, '7': { ID: 7, LoginName: 'otro@example.com' } },
    CertDomains: [N('self')],
    Peer,
  };
}

const FULL = statusWith([
  { host: 'pc-a' },
  { host: 'pc-b' },
  { host: 'other-app' },
  { host: 'html' },
  { host: 'forbidden' },
  { host: 'slow' },
  { host: 'offline', extra: { Online: false } },
  { host: 'tagged', extra: { Tags: ['tag:server'] } },
  { host: 'stranger', extra: { UserID: 7 } },
  { host: 'shared', extra: { UserID: 7, ShareeNode: true } },
]);

async function seccionDiscovery({ check, ROOT, handlers }) {
  const disc = require(path.join(ROOT, 'electron', 'web', 'discovery.js'));
  const storeService = require(path.join(ROOT, 'electron', 'services', 'store-service.js'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termilab-disc-'));
  const fakeJs = path.join(dir, 'fake-tailscale.js');
  const bin = path.join(dir, 'tailscale');
  const log = path.join(dir, 'calls.log');
  const jsonFile = path.join(dir, 'status.json');
  fs.writeFileSync(fakeJs, FAKE);
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${fakeJs}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(log, '');
  fs.writeFileSync(jsonFile, JSON.stringify(FULL));
  const saved = { bin: process.env.TERMILAB_TAILSCALE_BIN, log: process.env.FAKE_DISC_LOG, json: process.env.FAKE_DISC_JSON };
  process.env.TERMILAB_TAILSCALE_BIN = bin;
  process.env.FAKE_DISC_LOG = log;
  process.env.FAKE_DISC_JSON = jsonFile;
  const statusCalls = () => fs.readFileSync(log, 'utf-8').split('\n').filter(Boolean).length;

  // Certificado autofirmado para todos los nombres de prueba
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=termilab-test',
    '-addext', `subjectAltName=${NAMES.map(h => `DNS:${N(h)}`).join(',')}`], { stdio: 'ignore' });
  const ca = fs.readFileSync(cert);

  const hits = [];
  const slowRes = [];
  const json = (res, o) => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); };
  const srv = https.createServer({ key: fs.readFileSync(key), cert: ca }, (req, res) => {
    const host = String(req.headers.host || '').split(':')[0].split('.')[0];
    hits.push(host);
    if (req.url !== '/.well-known/termilab') { res.writeHead(404); res.end(); return; }
    if (host === 'pc-a') return json(res, { app: 'termilab', name: 'ubuntu-oficina', version: '1.22.2' });
    if (host === 'pc-b') return json(res, { app: 'termilab' });
    if (host === 'other-app') return json(res, { app: 'grafana', name: 'x' });
    if (host === 'html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>{"app":"termilab"}</html>'); return; }
    if (host === 'forbidden') { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('Forbidden'); return; }
    if (host === 'slow') { slowRes.push(res); return; }   // nunca contesta
    return json(res, { app: 'termilab', name: `no-deberia-${host}` });   // los filtrados: si llegan, se nota
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const lookup = (hostname, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    if (opts && opts.all) cb(null, [{ address: '127.0.0.1', family: 4 }]);
    else cb(null, '127.0.0.1', 4);
  };
  const agent = new https.Agent({ ca, lookup, keepAlive: false });

  let clock = 1000000;
  const make = (extra = {}) => disc.createDiscovery({ port, agent, timeoutMs: 400, concurrency: 3, now: () => clock, ...extra });

  try {
    await check('PC1 candidatos: offline, tagged, de otro usuario y compartidos fuera', () => {
      const { self, peers } = disc.candidates(FULL);
      assert.strictEqual(self.dnsName, N('self'));
      assert.deepStrictEqual(peers.map(p => p.dnsName.split('.')[0]).sort(), ['forbidden', 'html', 'other-app', 'pc-a', 'pc-b', 'slow']);
      assert.deepStrictEqual(disc.candidates({ BackendState: 'Stopped' }), { self: null, peers: [] });
      assert.deepStrictEqual(disc.candidates(null), { self: null, peers: [] });
      // Un DNSName que no es un nombre (inyeccion en la URL) tampoco pasa
      const bad = statusWith([{ host: 'x', extra: { DNSName: 'evil.com/@x.' } }]);
      assert.deepStrictEqual(disc.candidates(bad).peers, []);
    });

    let list = null;
    await check('PC2/PC3 responde Termilab: incluido; otra app, HTML, 403, timeout y filtrados: fuera', async () => {
      hits.length = 0;
      const t0 = Date.now();
      list = await make().peers({ selfName: 'mi-pc', selfVersion: '1.22.2' });
      assert.ok(Date.now() - t0 < 3000, 'el timeout no corto');
      const others = list.filter(p => !p.self);
      assert.deepStrictEqual(others.map(p => p.dnsName).sort(), [N('pc-a'), N('pc-b')]);
      const a = others.find(p => p.dnsName === N('pc-a'));
      assert.deepStrictEqual(a, { name: 'ubuntu-oficina', dnsName: N('pc-a'), url: `https://${N('pc-a')}:${port}/`, self: false, version: '1.22.2' });
      const b = others.find(p => p.dnsName === N('pc-b'));
      assert.strictEqual(b.name, 'pc-b', 'sin nombre en la respuesta: el HostName');
      assert.strictEqual(b.version, null);
      for (const h of ['offline', 'tagged', 'stranger', 'shared', 'self']) assert.ok(!hits.includes(h), `${h} fue sondeado`);
      for (const h of ['pc-a', 'pc-b', 'other-app', 'html', 'forbidden', 'slow']) assert.ok(hits.includes(h), `${h} no fue sondeado`);
    });

    await check('PC4 self marcado, primero, con el nombre y la version locales', () => {
      assert.ok(list && list.length === 3, `esperaba 3, hay ${list && list.length}`);
      assert.deepStrictEqual(list[0], { name: 'mi-pc', dnsName: N('self'), url: `https://${N('self')}:${port}/`, self: true, version: '1.22.2' });
      assert.strictEqual(list.filter(p => p.self).length, 1);
    });

    await check('PC5 cache: 60 s sin volver a tailscale ni a los peers; luego si; llamadas simultaneas comparten', async () => {
      const d = make({ ttlMs: 60000 });
      fs.writeFileSync(log, '');
      hits.length = 0;
      const [x, y] = await Promise.all([d.peers({ selfName: 'mi-pc' }), d.peers({ selfName: 'mi-pc' })]);
      assert.deepStrictEqual(x, y);
      assert.strictEqual(statusCalls(), 1, 'dos llamadas a la vez: un solo tailscale status');
      const probes = hits.length;
      assert.ok(probes > 0);
      clock += 59000;
      const z = await d.peers({ selfName: 'mi-pc' });
      assert.deepStrictEqual(z, x);
      z[0].name = 'mutado';
      assert.strictEqual((await d.peers({ selfName: 'mi-pc' }))[0].name, 'mi-pc', 'la cache se devuelve por copia');
      assert.strictEqual(statusCalls(), 1, 'dentro del TTL volvio a tailscale');
      assert.strictEqual(hits.length, probes, 'dentro del TTL volvio a sondear');
      // Un peer nuevo aparece al vencer la cache
      fs.writeFileSync(jsonFile, JSON.stringify(statusWith([{ host: 'pc-a' }])));
      clock += 2000;
      const w = await d.peers({ selfName: 'mi-pc' });
      assert.strictEqual(statusCalls(), 2);
      assert.deepStrictEqual(w.map(p => p.dnsName), [N('self'), N('pc-a')]);
      fs.writeFileSync(jsonFile, JSON.stringify(FULL));
    });

    await check('PC6 verificacion TLS por defecto: el autofirmado no pasa sin el agente de prueba', async () => {
      const plain = new https.Agent({ lookup, keepAlive: false });   // sin ca: el almacen del sistema
      assert.strictEqual(await disc.probe(N('pc-a'), { port, agent: plain, timeoutMs: 1000 }), null);
      assert.deepStrictEqual(await disc.probe(N('pc-a'), { port, agent, timeoutMs: 1000 }), { name: 'ubuntu-oficina', version: '1.22.2' });
      const src = fs.readFileSync(path.join(ROOT, 'electron', 'web', 'discovery.js'), 'utf-8');
      assert.ok(!/rejectUnauthorized|NODE_TLS_REJECT_UNAUTHORIZED|checkServerIdentity/.test(src), 'discovery.js toca la verificacion TLS');
    });

    await check('PC7 web:peers registrado, por el sobre, self con el nombre de settings.remoteAccess', async () => {
      assert.ok(handlers.has('web:peers'), 'falta web:peers');
      fs.writeFileSync(jsonFile, JSON.stringify(statusWith([])));   // sin peers: ninguna peticion de red
      await storeService.saveRemoteAccess({ hostName: 'escritorio-casa' });
      disc.clear();
      const r = await handlers.get('web:peers')({}, undefined);
      assert.strictEqual(r.success, true, r.error);
      assert.strictEqual(r.data.length, 1);
      assert.strictEqual(r.data[0].self, true);
      assert.strictEqual(r.data[0].name, 'escritorio-casa');
      assert.strictEqual(r.data[0].url, `https://${N('self')}:7443/`);
      disc.clear();
    });
  } finally {
    for (const r of slowRes) { try { r.destroy(); } catch (_) { /* ya cerrado */ } }
    agent.destroy();
    await new Promise(r => { srv.close(() => r()); if (srv.closeAllConnections) srv.closeAllConnections(); });
    for (const [k, v] of [['TERMILAB_TAILSCALE_BIN', saved.bin], ['FAKE_DISC_LOG', saved.log], ['FAKE_DISC_JSON', saved.json]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { seccionDiscovery };
