/**
 * The web mirror's HTTP server: the app (dist-web/), the preload bundle and
 * the gateway WebSocket, behind auth.js.
 *
 * It listens on loopback TCP, `127.0.0.1:<listenPort>` (the serve port + 1,
 * 7444 by default), which is where `tailscale serve` proxies to. The host is
 * a constant: there is no host / bind option, and start() refuses if the
 * bound address is anything else.
 *
 * Why not a unix socket: it was, 0600, but `tailscale serve` to a path or
 * unix socket needs root even for the operator ("401 Unauthorized: must be
 * root, or be an operator and able to run 'sudo tailscale' to serve a path
 * or Unix socket", Tailscale 1.104). A loopback port only needs the operator.
 *
 * What makes loopback TCP safe here, on Linux: every accepted connection is
 * checked against /proc/net/tcp (peer-uid.js) and kept only if the socket on
 * the other end belongs to uid 0, i.e. tailscaled. Any other local process
 * could forge `Tailscale-User-Login`, `Host` and `Origin` (auth.js trusts
 * them) and get the whole gateway; this check is what stops it. Not found,
 * or not 0: the socket is destroyed before a byte is parsed (fail closed).
 *
 * Linux only. start() refuses anywhere else, so remote access is off on
 * macOS and Windows for now (remote-access.js says so in the UI). There is no
 * /proc/net/tcp there: they would need their own way to tell tailscaled's
 * connections from any local process's (the owner of the peer socket, or a
 * secret in the serve target that a local process cannot learn) before the
 * port could be opened.
 *
 * Routes:
 *   GET /                        dist-web/index.html
 *   GET /termilab-preload.js     electron-stub.js + electron/preload.js, wrapped
 *   GET /.well-known/termilab    {app:'termilab', name, version} (F5 discovery)
 *   GET /<asset>                 dist-web/<asset>
 *   GET /ws (upgrade)            gateway.js
 * Every one of them, the WebSocket included, goes through auth first.
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const wsLite = require('./ws-lite');
const { createAuth, refuseHttp, refuseUpgrade } = require('./auth');
const { createGateway } = require('./gateway');
const peerUidOf = require('./peer-uid');

const ROOT = path.join(__dirname, '..', '..');
const MAX_MESSAGE = 32 * 1024 * 1024;   // a Compose image, base64'd, fits
/* The only address the server ever binds. Not an option, on purpose. */
const LOOPBACK = '127.0.0.1';
/* tailscaled runs as root: the only peer let through */
const TAILSCALED_UID = 0;

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

/**
 * @param {object} opts
 * @param {number} opts.listenPort     the loopback port tailscale serve proxies to (0: any, tests)
 * @param {() => string|null} opts.getAllowedLogin
 * @param {() => string|null} opts.getDnsName
 * @param {() => number|null} [opts.getPort]
 * @param {{name?: string, version?: string}} [opts.info]
 * @param {object} [opts.gateway]      createGateway() deps (tap, getHost, onConnect, onDisconnect)
 * @param {string} [opts.distDir]      default <repo>/dist-web
 * @param {number} [opts.maxMessage]
 * @param {(remote, local) => number|null} [opts.peerUid]  owner of the peer socket
 *        ({address, port} each); default reads /proc/net/tcp. Tests inject it.
 */
function createWebServer(opts) {
  const distDir = path.resolve(opts.distDir || path.join(ROOT, 'dist-web'));
  const info = { app: 'termilab', name: (opts.info && opts.info.name) || os.hostname(), version: (opts.info && opts.info.version) || '0.0.0' };
  const auth = createAuth({ getAllowedLogin: opts.getAllowedLogin, getDnsName: opts.getDnsName, getPort: opts.getPort });
  const gateway = createGateway(opts.gateway || {});
  const maxMessage = opts.maxMessage || MAX_MESSAGE;
  let preloadBundle = null;
  let server = null;
  let address = null;
  const peerUid = typeof opts.peerUid === 'function' ? opts.peerUid : peerUidOf.peerUid;

  /* Before the HTTP parser reads a byte: only tailscaled (uid 0) gets in */
  function onConnection(socket) {
    let uid = null;
    try {
      uid = peerUid(
        { address: socket.remoteAddress, port: socket.remotePort },
        { address: socket.localAddress, port: socket.localPort },
      );
    } catch (_) { uid = null; }
    if (uid !== TAILSCALED_UID) {
      console.warn(`[web] refused a loopback connection from ${socket.remoteAddress}:${socket.remotePort} (peer uid ${uid === null ? 'unknown' : uid}, not tailscaled)`);
      socket.destroy();
    }
  }

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

  /** The path of a request URL, or null when it does not parse. */
  function route(url) {
    try { return new URL(url, 'http://x').pathname; } catch (_) { return null; }
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
    gateway.attach(ws, { login: req.headers['tailscale-user-login'] || null, userAgent: req.headers['user-agent'] || null });
  }

  async function start() {
    if (server) return api.address();
    /* See the header: off Linux there is no peer-uid check, so loopback TCP would be open to any local process */
    if (process.platform !== 'linux') {
      throw new Error(`Remote access is available on Linux for now (this is ${process.platform}): not listening`);
    }
    const listenPort = opts.listenPort;
    if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535) throw new Error(`Invalid listen port: ${listenPort}`);
    const srv = http.createServer((req, res) => {
      onRequest(req, res).catch((err) => {
        console.error('[web] request failed:', err.message);
        if (!res.headersSent) send(res, 500, 'text/plain; charset=utf-8', 'Internal Server Error');
        else res.destroy();
      });
    });
    /* First listener after http's own, in the same emit: runs before any data */
    srv.on('connection', onConnection);
    srv.on('upgrade', onUpgrade);
    srv.on('clientError', (err, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (_) { /* gone */ } });
    srv.headersTimeout = 20000;
    srv.requestTimeout = 60000;
    await new Promise((resolve, reject) => {
      srv.once('error', (err) => {
        reject(err && err.code === 'EADDRINUSE'
          ? new Error(`Another Termilab (or something else) is already serving on ${LOOPBACK}:${listenPort}`)
          : err);
      });
      srv.listen({ port: listenPort, host: LOOPBACK, exclusive: true }, () => {
        srv.removeAllListeners('error');
        srv.on('error', (err) => console.error('[web] server error:', err.message));
        resolve();
      });
    });
    const bound = srv.address();
    if (!bound || typeof bound !== 'object' || bound.address !== LOOPBACK) {
      await new Promise(r => srv.close(() => r()));
      throw new Error(`The web server bound ${JSON.stringify(bound)}, not ${LOOPBACK}: not serving`);
    }
    address = { mode: 'tcp', host: LOOPBACK, port: bound.port };
    server = srv;
    return api.address();
  }

  async function stop() {
    const srv = server;
    if (!srv) return;
    server = null;
    gateway.closeAll();
    await new Promise(r => { srv.close(() => r()); if (srv.closeAllConnections) srv.closeAllConnections(); });
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

module.exports = { createWebServer, buildPreloadBundle, SECURITY_HEADERS, CSP, MAX_MESSAGE, LOOPBACK, TAILSCALED_UID };
