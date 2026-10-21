#!/usr/bin/env node
/**
 * Arnes del espejo web (electron/web/): servidor, auth, WebSocket propio,
 * gateway y el preload servido al navegador.
 *
 *   node scripts/check-web.js
 *
 * Levanta el servidor de verdad en un socket unix temporal y habla con el con
 * un cliente WebSocket propio (este archivo), frame a frame: handshake, mascara,
 * fragmentacion, ping, tope de tamano. Los handlers IPC son falsos, registrados
 * a traves de ipc-tap como lo hace main.js. Nada de tailscale real.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'electron', 'web');
const tap = require(path.join(WEB, 'ipc-tap'));
const { createWebServer } = require(path.join(WEB, 'server'));
const { toWire, WEB_CHANNELS, SECRET_FIELDS } = require(path.join(WEB, 'gateway'));
const stubMod = require(path.join(WEB, 'electron-stub'));
const wsLite = require(path.join(WEB, 'ws-lite'));

let failures = 0;
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n       ') : err}`);
  }
}

// ─── Fixtures ───────────────────────────────────────────────

const LOGIN = 'owner@example.com';
const DNS = 'pc.tail1234.ts.net.';     // como lo da `tailscale status --json`: con punto final
const HOSTNAME = 'pc.tail1234.ts.net';
const PORT = 7443;
const ORIGIN = `https://${HOSTNAME}:${PORT}`;
const GOOD = { 'Tailscale-User-Login': LOGIN, 'Tailscale-User-Name': 'Owner', Host: `${HOSTNAME}:${PORT}` };

const SECRETS = ['hunter2-pw', 'pass-phrase-xyz', '-----BEGIN OPENSSH PRIVATE KEY-----AAAA', 'jump-pw-777', 'tok-abc-123'];
const HOSTS = [
  { id: 'h1', label: 'Prod', hostname: '10.0.0.1', username: 'root', authType: 'password', password: SECRETS[0] },
  { id: 'h2', label: 'Key', hostname: '10.0.0.2', username: 'deploy', authType: 'key', keyId: 'k1', passphrase: SECRETS[1], privateKey: SECRETS[2],
    jumpHost: { hostname: 'bastion', Password: SECRETS[3] }, meta: { deviceToken: SECRETS[4], hasPrivateKey: true } },
];

const fakeIpcMain = { handle() {}, on() { return this; }, removeHandler() {}, removeListener() { return this; }, removeAllListeners() { return this; } };
tap.install(fakeIpcMain);
const envelope = fn => async (event, ...args) => {
  try { return { success: true, data: await fn(event, ...args) }; } catch (err) { return { success: false, error: err.message }; }
};
const seen = { connect: null, sendData: [], syncCalled: false, upload: null, senders: new Set() };
fakeIpcMain.handle('store:get-hosts', envelope(async (event) => { seen.senders.add(event.sender); return HOSTS; }));
fakeIpcMain.handle('store:get-groups', envelope(async () => []));
fakeIpcMain.handle('store:save-host', envelope(async () => { throw new Error('should never run from the web'); }));
fakeIpcMain.handle('sync:status', envelope(async () => { seen.syncCalled = true; return { token: 'x' }; }));
fakeIpcMain.handle('web:status', envelope(async () => ({ enabled: true })));
fakeIpcMain.handle('system:info', envelope(async (event, ...args) => ({ echo: args, platform: 'linux' })));
fakeIpcMain.handle('ssh:connect', envelope(async (event, config) => { seen.connect = config; return { sessionId: 's1' }; }));
fakeIpcMain.handle('attach:upload', envelope(async (event, sid, uploadId, items) => {
  seen.upload = items;
  return { sizes: items.map(i => i.data.length), first: items[0].data };
}));
fakeIpcMain.on('ssh:send-data', (event, sid, data) => { seen.sendData.push([event.sender, sid, data]); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termilab-web-'));
const distDir = path.join(tmp, 'dist-web');
fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><script src="./termilab-preload.js"></script>');
fs.writeFileSync(path.join(distDir, 'assets', 'app.js'), 'console.log(1)');
fs.writeFileSync(path.join(tmp, 'outside.txt'), 'SECRET-OUTSIDE');
const socketPath = path.join(tmp, 'userData', 'web', 'termilab.sock');

const events = { connected: [], disconnected: [] };
function makeServer(extra = {}) {
  return createWebServer({
    socketPath,
    distDir,
    mode: 'unix',
    getAllowedLogin: () => LOGIN,
    getDnsName: () => DNS,
    getPort: () => PORT,
    info: { name: 'test-pc', version: '9.9.9' },
    gateway: {
      tap,
      getHost: async id => HOSTS.find(h => h.id === id) || null,
      onConnect: wc => events.connected.push(wc),
      onDisconnect: wc => events.disconnected.push(wc),
    },
    ...extra,
  });
}

// ─── HTTP and WebSocket clients (unix socket) ───────────────

function request(pathname, headers = {}, { method = 'GET', target = { socketPath } } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ ...target, path: pathname, method, headers }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

function frame(opcode, payload, { fin = true, mask = true, lenOverride = null } = {}) {
  payload = Buffer.from(payload);
  const len = lenOverride != null ? lenOverride : payload.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; } else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); } else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = (fin ? 0x80 : 0) | opcode;
  if (!mask) return Buffer.concat([head, payload]);
  head[1] |= 0x80;
  const key = crypto.randomBytes(4);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= key[i & 3];
  return Buffer.concat([head, key, body]);
}

/** Raw WebSocket client. Resolves {status, ...client} after the HTTP response. */
function wsConnect(headers = {}, { pathname = '/ws', target = { path: socketPath } } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(target.path ? { path: target.path } : target);
    const key = crypto.randomBytes(16).toString('base64');
    let buf = Buffer.alloc(0);
    let handshaken = false;
    const messages = [];
    const waiters = [];
    const frames = [];
    let closeInfo = null;
    const closeWaiters = [];
    const deliver = (m) => {
      const i = waiters.findIndex(w => w.pred(m));
      if (i >= 0) { const [w] = waiters.splice(i, 1); w.resolve(m); } else messages.push(m);
    };
    const onClose = () => {
      if (!closeInfo) closeInfo = { code: 1006 };
      closeWaiters.splice(0).forEach(r => r(closeInfo));
      waiters.splice(0).forEach(w => w.reject(new Error('closed')));
    };
    sock.on('error', () => onClose());
    sock.on('close', onClose);
    sock.on('connect', () => {
      const lines = [`GET ${pathname} HTTP/1.1`, 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13'];
      for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
      sock.write(lines.join('\r\n') + '\r\n\r\n');
    });
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!handshaken) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.subarray(0, end).toString('utf-8');
        buf = buf.subarray(end + 4);
        const status = Number(head.split(' ')[1]);
        handshaken = true;
        if (status !== 101) { resolve({ status, head, body: buf.toString('utf-8') }); sock.destroy(); return; }
        const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head);
        assert.ok(accept && accept[1] === wsLite.acceptKey(key), 'Sec-WebSocket-Accept incorrecto');
        resolve(client(status));
      }
      // server frames: never masked
      while (buf.length >= 2) {
        const fin = (buf[0] & 0x80) !== 0;
        const op = buf[0] & 0x0F;
        assert.strictEqual(buf[1] & 0x80, 0, 'el servidor enmascaro un frame');
        let len = buf[1] & 0x7F; let pos = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); pos = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); pos = 10; }
        if (buf.length < pos + len) return;
        const payload = buf.subarray(pos, pos + len);
        buf = buf.subarray(pos + len);
        frames.push({ op, fin, payload });
        if (op === 0x1) deliver(JSON.parse(payload.toString('utf-8')));
        else if (op === 0xA) deliver({ t: '__pong', data: payload.toString('utf-8') });
        else if (op === 0x8) { closeInfo = { code: payload.length >= 2 ? payload.readUInt16BE(0) : 1005, reason: payload.subarray(2).toString('utf-8') }; }
      }
    });
    function client(status) {
      let seq = 0;
      return {
        status,
        sock,
        frames,
        raw: (b) => sock.write(b),
        sendText: (s, opts) => sock.write(frame(0x1, s, opts)),
        next: (pred = () => true, ms = 3000) => {
          const i = messages.findIndex(pred);
          if (i >= 0) return Promise.resolve(messages.splice(i, 1)[0]);
          return new Promise((res, rej) => {
            const w = { pred, resolve: res, reject: rej };
            waiters.push(w);
            setTimeout(() => { const k = waiters.indexOf(w); if (k >= 0) { waiters.splice(k, 1); rej(new Error('timeout waiting for a message')); } }, ms);
          });
        },
        invoke(ch, args = [], opts) {
          const id = ++seq;
          sock.write(frame(0x1, JSON.stringify({ t: 'invoke', id, ch, args }), opts));
          return this.next(m => m.t === 'res' && m.id === id);
        },
        send(ch, args = []) { sock.write(frame(0x1, JSON.stringify({ t: 'send', ch, args }))); },
        closed: (ms = 3000) => (closeInfo && sock.destroyed ? Promise.resolve(closeInfo) : new Promise((res, rej) => {
          closeWaiters.push(res);
          setTimeout(() => rej(new Error('timeout waiting for close')), ms);
        })),
        end: () => { sock.write(frame(0x8, Buffer.from([0x03, 0xE8]))); },
      };
    }
    setTimeout(() => reject(new Error('ws connect timeout')), 3000);
  });
}

const WS_OK = { ...GOOD, Origin: ORIGIN };

/** electron/preload.js as the check-mobile harness loads it (loadPreloadApi). */
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

/** A browser-ish WebSocket over the raw client, for the stub inside a vm. */
function browserWebSocket(headers) {
  return class FakeBrowserWS {
    constructor() {
      this.readyState = 0;
      wsConnect(headers).then((c) => {
        this.c = c;
        if (c.status !== 101) { this.readyState = 3; if (this.onclose) this.onclose({}); return; }
        this.readyState = 1;
        const pump = () => c.next(() => true, 60000).then((m) => { if (this.onmessage) this.onmessage({ data: JSON.stringify(m) }); pump(); }, () => {});
        pump();
        c.sock.on('close', () => { this.readyState = 3; if (this.onclose) this.onclose({}); });
        if (this.onopen) this.onopen({});
      });
    }
    send(s) { this.c.sendText(s); }
    close() { this.c.end(); }
  };
}

// ─── Main ───────────────────────────────────────────────────

async function main() {
  console.log('check-web: espejo web (electron/web/)');
  const server = makeServer();

  // Un socket viejo (de un cierre brusco) en la ruta: start() lo borra
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o755 });
  require('child_process').spawnSync(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(socketPath)}, () => process.exit(0))`]);
  assert.ok(fs.lstatSync(socketPath).isSocket(), 'no se pudo dejar un socket viejo');

  await check('WS0 arranca en el socket unix; socket 0600, carpeta 0700, socket viejo borrado', async () => {
    const a = await server.start();
    assert.strictEqual(a.mode, 'unix');
    assert.strictEqual(a.socketPath, socketPath);
    assert.strictEqual(fs.statSync(socketPath).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(path.dirname(socketPath)).mode & 0o777, 0o700);
  });

  await check('WS1 HTTP con login correcto: 200 y cabeceras de seguridad', async () => {
    const r = await request('/', GOOD);
    assert.strictEqual(r.status, 200);
    assert.ok(/default-src 'none'/.test(r.headers['content-security-policy']) && /script-src 'self'/.test(r.headers['content-security-policy']));
    assert.ok(/frame-ancestors 'none'/.test(r.headers['content-security-policy']));
    assert.strictEqual(r.headers['x-frame-options'], 'DENY');
    assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
    assert.ok(!r.headers['access-control-allow-origin'], 'no hay CORS');
    assert.ok(!r.headers['set-cookie'], 'no hay cookies');
    const asset = await request('/assets/app.js', GOOD);
    assert.strictEqual(asset.status, 200);
    assert.ok(/javascript/.test(asset.headers['content-type']));
  });

  await check('WS2 HTTP: login ajeno, sin cabecera, Host malo, Origin malo -> 403 sin detalles', async () => {
    const cases = [
      { ...GOOD, 'Tailscale-User-Login': 'intruder@example.com' },
      { Host: GOOD.Host },
      { ...GOOD, Host: 'evil.example.com' },
      { ...GOOD, Origin: 'https://evil.example.com' },
    ];
    const bodies = new Set();
    for (const h of cases) {
      const r = await request('/', h);
      assert.strictEqual(r.status, 403, JSON.stringify(h));
      bodies.add(r.body);
    }
    assert.strictEqual(bodies.size, 1, 'el 403 delata la causa');
    assert.ok(!/login|host|origin/i.test([...bodies][0]));
  });

  await check('WS3 no se sale de dist-web (path traversal)', async () => {
    for (const p of ['/../outside.txt', '/%2e%2e/outside.txt', '/assets/..%2f..%2foutside.txt']) {
      const r = await request(p, GOOD);
      assert.notStrictEqual(r.status, 200, p);
      assert.ok(!r.body.includes('SECRET-OUTSIDE'), p);
    }
  });

  await check('WS4 /.well-known/termilab con auth -> {app,name,version}; sin auth -> 403', async () => {
    const r = await request('/.well-known/termilab', GOOD);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(JSON.parse(r.body), { app: 'termilab', name: 'test-pc', version: '9.9.9' });
    assert.strictEqual((await request('/.well-known/termilab', {})).status, 403);
    assert.strictEqual((await request('/.well-known/termilab', { ...GOOD, 'Tailscale-User-Login': 'x@y' })).status, 403);
  });

  await check('WS5 upgrade: login ajeno, sin cabecera, sin Origin, Origin malo, Host malo -> 403', async () => {
    const cases = [
      { ...WS_OK, 'Tailscale-User-Login': 'intruder@example.com' },
      { Host: GOOD.Host, Origin: ORIGIN },
      { ...GOOD },
      { ...WS_OK, Origin: 'https://evil.example.com' },
      { ...WS_OK, Origin: `http://${HOSTNAME}:${PORT}` },
      { ...WS_OK, Host: 'evil.example.com' },
    ];
    for (const h of cases) {
      const c = await wsConnect(h);
      assert.strictEqual(c.status, 403, JSON.stringify(h));
    }
    assert.strictEqual(events.connected.length, 0, 'un upgrade rechazado creo un webContents');
  });

  const c = await wsConnect(WS_OK);
  await check('WS6 upgrade con login y Origin correctos -> 101 y un webContents virtual', async () => {
    assert.strictEqual(c.status, 101);
    assert.strictEqual(events.connected.length, 1);
    const wc = events.connected[0];
    assert.ok(Number.isInteger(wc.id) && wc.id >= 1000000);
    assert.strictEqual(wc.isDestroyed(), false);
    assert.strictEqual(typeof wc.send, 'function');
    assert.ok(!('webContents' in wc), 'el registry lo tomaria por una ventana');
    // Origin sin puerto tambien vale
    const c2 = await wsConnect({ ...WS_OK, Origin: `https://${HOSTNAME}` });
    assert.strictEqual(c2.status, 101);
    c2.end();
    await c2.closed();
  });

  await check('WS7 store:get-hosts llega con el sobre de wrapHandler y sin un solo secreto', async () => {
    const r = await c.invoke('store:get-hosts');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.v.success, true);
    const hosts = r.v.data;
    assert.strictEqual(hosts.length, 2);
    assert.strictEqual(hosts[0].label, 'Prod');
    assert.strictEqual(hosts[1].keyId, 'k1');
    assert.strictEqual(hosts[1].meta.hasPrivateKey, true, 'hasPrivateKey es inofensivo y la UI lo usa');
    for (const h of hosts) for (const f of ['password', 'passphrase', 'privateKey']) assert.ok(!(f in h), `${f} en ${h.id}`);
    assert.ok(!('Password' in hosts[1].jumpHost), 'anidado, otra capitalizacion');
    const raw = c.frames.map(f => f.payload.toString('utf-8')).join('\n');
    for (const s of SECRETS) assert.ok(!raw.includes(s), `el secreto ${s} salio por el socket`);
    assert.ok(seen.senders.has(events.connected[0]), 'event.sender no es el webContents virtual');
  });

  await check('WS8 canales fuera de la lista blanca: rechazados, el handler no corre', async () => {
    for (const ch of ['sync:status', 'store:save-host', 'web:status', 'clipboard:read-text', 'sftp:list', 'no:existe']) {
      const r = await c.invoke(ch, []);
      assert.strictEqual(r.ok, false, ch);
      assert.ok(/not available/i.test(r.e), ch);
    }
    c.send('clipboard:write-text', ['x']);
    assert.strictEqual(seen.syncCalled, false);
    for (const ch of ['sync:status', 'store:save-host', 'store:delete-host', 'store:paste-key', 'store:import-key', 'dialog:open-file',
      'port-forward:start', 'local-fs:list', 'web:status', 'web:enable', 'clipboard:read-text', 'paths:open', 'cli:install', 'updater:install']) {
      assert.ok(!WEB_CHANNELS.has(ch), `${ch} no debe estar en la lista blanca`);
    }
    for (const ch of WEB_CHANNELS) {
      assert.ok(!/^(sync|web|clipboard|dialog|sftp|port-forward|local-fs|keys):/.test(ch), ch);
      assert.ok(!/^store:(save|delete)-/.test(ch), ch);
    }
  });

  await check('WS9 fragmentacion + mascara: 3 fragmentos con un ping en medio; tambien sin mascara', async () => {
    const msg = Buffer.from(JSON.stringify({ t: 'invoke', id: 9001, ch: 'system:info', args: ['fragmentado', 'ñandú ✓'] }));
    const a = msg.subarray(0, 10); const b = msg.subarray(10, 30); const d = msg.subarray(30);
    c.raw(frame(0x1, a, { fin: false }));
    c.raw(frame(0x9, 'hola-ping'));
    c.raw(frame(0x0, b, { fin: false }));
    c.raw(frame(0x0, d, { fin: true }));
    const pong = await c.next(m => m.t === '__pong');
    assert.strictEqual(pong.data, 'hola-ping');
    const r = await c.next(m => m.t === 'res' && m.id === 9001);
    assert.deepStrictEqual(r.v.data.echo, ['fragmentado', 'ñandú ✓']);
    const r2 = await c.invoke('system:info', ['sin-mascara'], { mask: false });
    assert.deepStrictEqual(r2.v.data.echo, ['sin-mascara']);
  });

  await check('WS10 ipcRenderer.send llega a ipcMain.on con el webContents virtual', async () => {
    c.send('ssh:send-data', ['s1', 'ls\r']);
    await new Promise(r => setTimeout(r, 100));
    assert.strictEqual(seen.sendData.length, 1);
    assert.strictEqual(seen.sendData[0][0], events.connected[0]);
    assert.deepStrictEqual(seen.sendData[0].slice(1), ['s1', 'ls\r']);
  });

  await check('WS11 ssh:connect: fuera por defecto (espejo); con el canal abierto usa la password guardada y nunca vuelve', async () => {
    const refused = await c.invoke('ssh:connect', [{ hostId: 'h1', host: '10.0.0.1', username: 'root' }]);
    assert.strictEqual(refused.ok, false, 'el navegador abrio una sesion propia');
    assert.strictEqual(seen.connect, null);
    for (const ch of ['ssh:connect', 'ssh:disconnect', 'local:spawn', 'local:kill', 'ssh:keeper-end', 'local:keeper-end', 'ssh:keeper-kill', 'local:keeper-kill', 'mirror:report', 'web:clients', 'web:kick']) {
      assert.ok(!WEB_CHANNELS.has(ch), `${ch} no debe estar en la lista blanca`);
    }
    const open = makeServer({ mode: 'tcp', tcpPort: 0, gateway: { tap, getHost: async id => HOSTS.find(h => h.id === id) || null, channels: new Set([...WEB_CHANNELS, 'ssh:connect']) } });
    const addr = await open.start();
    const oc = await wsConnect(WS_OK, { target: { host: '127.0.0.1', port: addr.port } });
    const r = await oc.invoke('ssh:connect', [{ hostId: 'h1', host: '10.0.0.1', username: 'root', privateKeyPath: '/etc/shadow' }]);
    oc.end();
    await open.stop();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(seen.connect.password, SECRETS[0]);
    assert.ok(!('privateKeyPath' in seen.connect), 'el navegador nombro una ruta del PC');
    assert.ok(!JSON.stringify(r).includes(SECRETS[0]));
  });

  await check('WS12 binarios {$b} ida y vuelta; un item con ruta del PC se rechaza', async () => {
    const bytes = crypto.randomBytes(3000);
    const r = await c.invoke('attach:upload', ['s1', 'u1', [{ name: 'a.png', data: { $b: bytes.toString('base64') } }]]);
    assert.strictEqual(r.ok, true);
    assert.ok(Buffer.isBuffer(seen.upload[0].data) && seen.upload[0].data.equals(bytes));
    assert.deepStrictEqual(r.v.data.sizes, [3000]);
    assert.strictEqual(Buffer.from(r.v.data.first.$b, 'base64').equals(bytes), true);
    seen.upload = null;
    const bad = await c.invoke('attach:upload', ['s1', 'u2', [{ path: '/home/derek/.ssh/id_ed25519' }]]);
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(seen.upload, null, 'el handler corrio con una ruta');
  });

  await check('WS13 pushes: llegan como {t:ev}, redactados; sync:* y web:* nunca', async () => {
    const wc = events.connected[0];
    wc.send('sync:status', { signedIn: true });
    wc.send('web:status', { enabled: true });
    wc.send('ssh:host-key-prompt', { requestId: 'r', password: 'leak-me', host: 'x' });
    wc.send('ssh:data', 's1', 'hola');
    const p = await c.next(m => m.t === 'ev' && m.ch === 'ssh:host-key-prompt');
    assert.ok(!('password' in p.args[0]));
    const d = await c.next(m => m.t === 'ev' && m.ch === 'ssh:data');
    assert.deepStrictEqual(d.args, ['s1', 'hola']);
    const raw = c.frames.map(f => f.payload.toString('utf-8')).join('\n');
    assert.ok(!raw.includes('"sync:status"') && !raw.includes('"web:status"') && !raw.includes('leak-me'));
  });

  await check('WS14 redaccion: lista explicita, a cualquier profundidad, campo por campo', () => {
    const expected = ['password', 'passphrase', 'privatekey', 'keys', 'token', 'accesstoken', 'refreshtoken', 'devicetoken', 'secret', 'apikey', 'masterkey'];
    for (const f of expected) assert.ok(SECRET_FIELDS.has(f), `${f} falta en SECRET_FIELDS`);
    const input = { a: [{ b: { c: {} } }], hasPrivateKey: true, keyId: 'k', label: 'x' };
    for (const f of SECRET_FIELDS) { input[f] = 'S'; input.a[0].b.c[f] = 'S'; input.a[0][f.toUpperCase()] = 'S'; }
    const out = toWire(input);
    assert.ok(!JSON.stringify(out).includes('"S"'), JSON.stringify(out));
    assert.deepStrictEqual(Object.keys(out).sort(), ['a', 'hasPrivateKey', 'keyId', 'label']);
    const cyc = { x: 1 }; cyc.self = cyc;
    assert.deepStrictEqual(toWire(cyc), { x: 1, self: null });
  });

  await check('WS15 mensaje mas grande que el tope (32 MB): cierre 1009 sin leer el cuerpo', async () => {
    const big = await wsConnect(WS_OK);
    big.raw(frame(0x1, Buffer.alloc(0), { lenOverride: 32 * 1024 * 1024 + 1 }).subarray(0, 14));
    const info = await big.closed();
    assert.strictEqual(info.code, 1009);
    // fragmentado: la suma cuenta
    const big2 = await wsConnect(WS_OK);
    big2.raw(frame(0x1, Buffer.alloc(100), { fin: false }));
    big2.raw(frame(0x0, Buffer.alloc(0), { lenOverride: 32 * 1024 * 1024 - 50 }).subarray(0, 14));
    assert.strictEqual((await big2.closed()).code, 1009);
  });

  await check('WS16 protocolo: frame sin cerrar continuacion, opcode desconocido, binario -> cierre', async () => {
    const x = await wsConnect(WS_OK);
    x.raw(frame(0x0, 'sin-inicio'));
    assert.strictEqual((await x.closed()).code, 1002);
    const y = await wsConnect(WS_OK);
    y.raw(frame(0x3, 'x'));
    assert.strictEqual((await y.closed()).code, 1002);
    const z = await wsConnect(WS_OK);
    z.raw(frame(0x2, Buffer.from([1, 2, 3])));
    assert.strictEqual((await z.closed()).code, 1003);
  });

  await check('WS17 el stub expone preload.js menos WEB_OMITTED, y nada de WEB_OMITTED', async () => {
    const pre = loadPreloadApi();
    const r = await request('/termilab-preload.js', GOOD);
    assert.strictEqual(r.status, 200);
    const win = { location: { protocol: 'https:', host: `${HOSTNAME}:${PORT}`, pathname: '/' }, WebSocket: browserWebSocket(WS_OK) };
    const ctx = vm.createContext({ window: win, console, setTimeout, clearTimeout, btoa: s => Buffer.from(s, 'binary').toString('base64'), atob: s => Buffer.from(s, 'base64').toString('binary'), Uint8Array, ArrayBuffer, Promise, Map, JSON, Object, Array, String });
    Object.assign(win, { btoa: ctx.btoa, atob: ctx.atob });
    vm.runInContext(r.body, ctx, { filename: 'termilab-preload.js' });
    const api = win.electronAPI;
    assert.ok(api, 'no se expuso electronAPI');
    assert.strictEqual(win.__termilabWeb, true);
    const expected = Object.keys(pre).filter(k => !stubMod.WEB_OMITTED.includes(k)).sort();
    assert.deepStrictEqual(Object.keys(api).sort(), expected);
    for (const k of stubMod.WEB_OMITTED) {
      assert.ok(k in pre, `WEB_OMITTED tiene ${k}, que preload.js no expone: lista vieja`);
      assert.ok(!(k in api), `${k} expuesto`);
    }
    assert.strictEqual(api.platform, process.platform);
    // De punta a punta: preload real -> stub -> WS -> gateway -> handler; el sobre lo desenvuelve preload
    const hosts = await api.store.getHosts();
    assert.strictEqual(hosts.length, 2);
    assert.ok(!('password' in hosts[0]));
    await assert.rejects(api.store.saveHost({ id: 'h1' }), /not available/i);
    assert.strictEqual(api.attach.pathForFile({}), null, 'webUtils nulo -> null');
  });

  await check('WS18 al desconectar: webContents destruido, evento destroyed, onDisconnect', async () => {
    const wc = events.connected[0];
    let destroyedEvents = 0;
    wc.on('destroyed', () => destroyedEvents++);
    c.end();
    await c.closed();
    await new Promise(r => setTimeout(r, 100));
    assert.strictEqual(wc.isDestroyed(), true);
    assert.strictEqual(destroyedEvents, 1);
    assert.ok(events.disconnected.includes(wc));
    wc.send('ssh:data', 's1', 'tarde');   // no lanza
  });

  await check('WS19 stop(): cierra los sockets y borra el socket; otro start() reutiliza la ruta', async () => {
    const live = await wsConnect(WS_OK);
    await server.stop();
    assert.ok(!fs.existsSync(socketPath));
    assert.strictEqual((await live.closed()).code, 1001);
    const again = makeServer();
    await again.start();
    assert.strictEqual((await request('/.well-known/termilab', GOOD)).status, 200);
    await assert.rejects(makeServer().start(), /already serving/);
    await again.stop();
  });

  await check('WS20 modo TCP (Mac/Windows): solo 127.0.0.1, sin opcion de bind; prefijo secreto opcional', async () => {
    const tcp = makeServer({ mode: 'tcp', tcpPort: 0, host: '0.0.0.0', bind: '0.0.0.0' });
    const a = await tcp.start();
    assert.strictEqual(a.host, '127.0.0.1');
    assert.strictEqual(a.prefix, '');
    const target = { host: '127.0.0.1', port: a.port };
    assert.strictEqual((await request('/.well-known/termilab', GOOD, { target })).status, 200);
    assert.strictEqual((await request('/.well-known/termilab', {}, { target })).status, 403);
    await tcp.stop();
    const sec = makeServer({ mode: 'tcp', tcpPort: 0, secretPrefix: true });
    const b = await sec.start();
    assert.ok(/^\/[0-9a-f]{32}$/.test(b.prefix));
    const t2 = { host: '127.0.0.1', port: b.port };
    assert.strictEqual((await request('/.well-known/termilab', GOOD, { target: t2 })).status, 404);
    assert.strictEqual((await request(`${b.prefix}/.well-known/termilab`, GOOD, { target: t2 })).status, 200);
    const w = await wsConnect(WS_OK, { pathname: `${b.prefix}/ws`, target: t2 });
    assert.strictEqual(w.status, 101);
    w.end();
    await w.closed();
    await sec.stop();
    const src = fs.readFileSync(path.join(WEB, 'server.js'), 'utf-8');
    assert.ok(!/opts\.(host|bind)\b/.test(src), 'server.js lee una opcion de bind');
  });

  await check('WS21 gatewayUrl respeta el prefijo; el stub reemplaza binarios por {$b}', () => {
    assert.strictEqual(stubMod.gatewayUrl({ protocol: 'https:', host: 'pc:7443', pathname: '/' }), 'wss://pc:7443/ws');
    assert.strictEqual(stubMod.gatewayUrl({ protocol: 'https:', host: 'pc', pathname: '/abc/index.html' }), 'wss://pc/abc/ws');
  });

  console.log(`\ncheck-web: ${passed} ok, ${failures} fallos`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
