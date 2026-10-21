/**
 * The web mirror's HTTP server: the app (dist-web/), the preload bundle and
 * the gateway WebSocket, behind auth.js.
 *
 * It listens ONLY where `tailscale serve` proxies to:
 *  - Linux: a unix socket at `socketPath` (its directory 0700, the socket
 *    0600). Never TCP.
 *  - macOS / Windows (prepared; tailscale serve there proxies to
 *    http://127.0.0.1:<serve port + 1>, 7444 by default): host fixed at
 *    127.0.0.1, port `tcpPort`. After listen() the bound address is checked
 *    and the server closes itself if it is not loopback. There is no bind
 *    option, on purpose.
 *    RISK: any local process can reach loopback and forge the Tailscale
 *    headers. `secretPrefix: true` puts every path under a random secret
 *    prefix (address().prefix), but only works if the serve target carries
 *    that path; the current serve-guard target has none, so it is off by
 *    default.
 *
 * Routes (after the prefix):
 *   GET /                        dist-web/index.html
 *   GET /termilab-preload.js     electron-stub.js + electron/preload.js, wrapped
 *   GET /.well-known/termilab    {app:'termilab', name, version} (F5 discovery)
 *   GET /<asset>                 dist-web/<asset>
 *   GET /ws (upgrade)            gateway.js
 * Every one of them, the WebSocket included, goes through auth first.
 */
const http = require('http');
const net = require('net');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const wsLite = require('./ws-lite');
const { createAuth, refuseHttp, refuseUpgrade } = require('./auth');
const { createGateway } = require('./gateway');

const ROOT = path.join(__dirname, '..', '..');
const LOOPBACK = '127.0.0.1';
const DEFAULT_TCP_PORT = 7444;   // tailscale.DEFAULT_PORT (7443) + 1, where serve proxies off Linux
const MAX_MESSAGE = 32 * 1024 * 1024;   // a Compose image, base64'd, fits

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=()',
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

/** stub + preload, the latter inside a function with its own require/module/process. */
function buildPreloadBundle({ stubPath, preloadPath, platform }) {
  const stub = fs.readFileSync(stubPath, 'utf-8');
  const preload = fs.readFileSync(preloadPath, 'utf-8');
  return `${stub}\n;(function (require, module, exports, process) {\n${preload}\n})(window.__termilabWebRequire, { exports: {} }, {}, { platform: ${JSON.stringify(platform)}, env: {} });\n`;
}

/** Is something already answering on this unix socket (another Termilab)? */
function socketInUse(p) {
  return new Promise((resolve) => {
    const c = net.connect(p);
    const done = (v) => { c.removeAllListeners(); c.destroy(); resolve(v); };
    c.once('connect', () => done(true));
    c.once('error', () => done(false));
    setTimeout(() => done(false), 1000).unref();
  });
}

async function prepareSocketPath(socketPath) {
  const dir = path.dirname(socketPath);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  await fsp.chmod(dir, 0o700);
  let st = null;
  try { st = await fsp.lstat(socketPath); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  if (!st) return;
  if (!st.isSocket()) throw new Error(`${socketPath} exists and is not a socket`);
  if (await socketInUse(socketPath)) throw new Error('Another Termilab is already serving the web mirror');
  await fsp.unlink(socketPath);
}

/**
 * @param {object} opts
 * @param {string} [opts.socketPath]   required in unix mode
 * @param {() => string|null} opts.getAllowedLogin
 * @param {() => string|null} opts.getDnsName
 * @param {() => number|null} [opts.getPort]
 * @param {{name?: string, version?: string}} [opts.info]
 * @param {object} [opts.gateway]      createGateway() deps (tap, getHost, onConnect, onDisconnect)
 * @param {string} [opts.distDir]      default <repo>/dist-web
 * @param {'unix'|'tcp'} [opts.mode]   default: unix on Linux, tcp elsewhere
 * @param {number} [opts.tcpPort]      tcp mode: the fixed loopback port (default 7444; 0 = any, tests)
 * @param {boolean} [opts.secretPrefix] tcp mode: random path prefix (see RISK above)
 * @param {number} [opts.maxMessage]
 */
function createWebServer(opts) {
  const mode = opts.mode || (process.platform === 'linux' ? 'unix' : 'tcp');
  const distDir = path.resolve(opts.distDir || path.join(ROOT, 'dist-web'));
  const info = { app: 'termilab', name: (opts.info && opts.info.name) || os.hostname(), version: (opts.info && opts.info.version) || '0.0.0' };
  const auth = createAuth({ getAllowedLogin: opts.getAllowedLogin, getDnsName: opts.getDnsName, getPort: opts.getPort });
  const gateway = createGateway(opts.gateway || {});
  const prefix = mode === 'tcp' && opts.secretPrefix ? `/${crypto.randomBytes(16).toString('hex')}` : '';
  const tcpPort = Number.isInteger(opts.tcpPort) ? opts.tcpPort : DEFAULT_TCP_PORT;
  const maxMessage = opts.maxMessage || MAX_MESSAGE;
  let preloadBundle = null;
  let server = null;
  let address = null;

  const preload = () => {
    if (!preloadBundle) {
      preloadBundle = buildPreloadBundle({
        stubPath: path.join(__dirname, 'electron-stub.js'),
        preloadPath: path.join(__dirname, '..', 'preload.js'),
        platform: opts.platform || process.platform,
      });
    }
    return preloadBundle;
  };

  /** The path inside the app, or null when outside the prefix. */
  function route(url) {
    let pathname;
    try { pathname = new URL(url, 'http://x').pathname; } catch (_) { return null; }
    if (prefix) {
      if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return null;
      pathname = pathname.slice(prefix.length) || '/';
    }
    return pathname;
  }

  function send(res, status, type, body, extra = {}) {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...extra });
    res.end(res.req && res.req.method === 'HEAD' ? undefined : body);
  }

  async function serveStatic(req, res, pathname) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch (_) { return send(res, 400, 'text/plain; charset=utf-8', 'Bad Request'); }
    if (rel.includes('\0')) return send(res, 400, 'text/plain; charset=utf-8', 'Bad Request');
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.resolve(distDir, `.${rel}`);
    if (file !== distDir && !file.startsWith(distDir + path.sep)) return send(res, 404, 'text/plain; charset=utf-8', 'Not Found');
    let data;
    try {
      const st = await fsp.stat(file);
      if (!st.isFile()) throw new Error('not a file');
      data = await fsp.readFile(file);
    } catch (_) {
      if (rel === '/index.html') return send(res, 503, 'text/plain; charset=utf-8', 'The web app is not built (npm run web:build)');
      return send(res, 404, 'text/plain; charset=utf-8', 'Not Found');
    }
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const cache = rel.startsWith('/assets/') ? 'private, max-age=31536000, immutable' : 'no-store';
    return send(res, 200, type, data, { 'Cache-Control': cache });
  }

  async function onRequest(req, res) {
    const pathname = route(req.url);
    if (pathname === null) return send(res, 404, 'text/plain; charset=utf-8', 'Not Found');
    const why = auth.check(req);
    if (why) { console.warn(`[web] 403 ${req.method} ${pathname.slice(0, 80)}: ${why}`); return refuseHttp(res); }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'text/plain; charset=utf-8', 'Method Not Allowed', { Allow: 'GET, HEAD' });
    }
    if (pathname === '/.well-known/termilab') {
      return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(info), { 'Cache-Control': 'no-store' });
    }
    if (pathname === '/termilab-preload.js') {
      return send(res, 200, 'text/javascript; charset=utf-8', preload(), { 'Cache-Control': 'no-store' });
    }
    if (pathname === '/ws') return send(res, 426, 'text/plain; charset=utf-8', 'Upgrade Required', { Upgrade: 'websocket' });
    return serveStatic(req, res, pathname);
  }

  function onUpgrade(req, socket, head) {
    socket.on('error', () => {});
    const pathname = route(req.url);
    if (pathname !== '/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const why = auth.check(req, { upgrade: true });
    if (why) { console.warn(`[web] 403 upgrade: ${why}`); refuseUpgrade(socket); return; }
    const ws = wsLite.accept(req, socket, head, { maxMessage });
    if (!ws) return;
    gateway.attach(ws, { login: req.headers['tailscale-user-login'] || null });
  }

  async function start() {
    if (server) return api.address();
    const srv = http.createServer((req, res) => {
      onRequest(req, res).catch((err) => {
        console.error('[web] request failed:', err.message);
        if (!res.headersSent) send(res, 500, 'text/plain; charset=utf-8', 'Internal Server Error');
        else res.destroy();
      });
    });
    srv.on('upgrade', onUpgrade);
    srv.on('clientError', (err, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (_) { /* gone */ } });
    srv.headersTimeout = 20000;
    srv.requestTimeout = 60000;
    if (mode === 'unix') {
      if (!opts.socketPath) throw new Error('socketPath is required');
      await prepareSocketPath(opts.socketPath);
      await new Promise((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(opts.socketPath, () => { srv.removeListener('error', reject); resolve(); });
      });
      await fsp.chmod(opts.socketPath, 0o600);
      address = { mode, socketPath: opts.socketPath, prefix };
    } else {
      await new Promise((resolve, reject) => {
        srv.once('error', reject);
        srv.listen({ host: LOOPBACK, port: tcpPort, exclusive: true }, () => { srv.removeListener('error', reject); resolve(); });
      });
      const a = srv.address();
      if (!a || typeof a !== 'object' || a.address !== LOOPBACK) {
        await new Promise(r => srv.close(r));
        throw new Error(`Web server bound to ${a && a.address}, not loopback: closed`);
      }
      address = { mode, host: LOOPBACK, port: a.port, prefix };
    }
    server = srv;
    return api.address();
  }

  async function stop() {
    const srv = server;
    if (!srv) return;
    server = null;
    gateway.closeAll();
    await new Promise(r => { srv.close(() => r()); if (srv.closeAllConnections) srv.closeAllConnections(); });
    if (mode === 'unix' && opts.socketPath) {
      try { await fsp.unlink(opts.socketPath); } catch (_) { /* already gone */ }
    }
    address = null;
  }

  const api = {
    start,
    stop,
    gateway,
    address: () => (address ? { ...address } : null),
    isRunning: () => !!server,
  };
  return api;
}

module.exports = { createWebServer, buildPreloadBundle, SECURITY_HEADERS, CSP, MAX_MESSAGE, DEFAULT_TCP_PORT };
