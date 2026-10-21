/**
 * Who may talk to the web mirror. The only way in is `tailscale serve`
 * (HTTPS on the tailnet -> this process's unix socket), which stamps every
 * request with the caller's Tailscale identity. A request is let through only
 * if ALL of these hold:
 *
 *  - `Tailscale-User-Login` equals the owner's login (getAllowedLogin()).
 *    Missing header = refused: Funnel and tagged devices carry none.
 *  - `Host` is this machine's tailnet name (getDnsName()), with or without
 *    the serve port.
 *  - On a WebSocket upgrade, `Origin` is https://<dnsName>[:<port>] — a page
 *    on another site cannot open a socket here with the owner's browser.
 *    Plain HTTP requests may omit Origin; one that sends a foreign one is refused.
 *
 * Those headers are trusted only because nothing but tailscaled can reach
 * the server: it listens on a 0600 unix socket (Linux only, see server.js).
 * On a loopback TCP port any local process could forge all three.
 *
 * No cookies, no token, no CORS headers: nothing a browser could replay or
 * relax. Failure is a bare 403 with no reason (the reason goes to the log).
 */

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
/** MagicDNS names come with a trailing dot from `tailscale status --json`. */
const normHost = (s) => norm(s).replace(/\.$/, '');

function header(req, name) {
  const v = req.headers[name];
  return Array.isArray(v) ? null : v;   // a repeated identity header is suspicious, not ambiguous
}

/**
 * @param {object} deps
 * @param {() => string|null} deps.getAllowedLogin
 * @param {() => string|null} deps.getDnsName
 * @param {() => number|null} [deps.getPort]  the HTTPS port tailscale serve listens on
 */
function createAuth({ getAllowedLogin, getDnsName, getPort = () => null }) {
  /** Returns null when allowed, else a short reason (for the log, never the client). */
  function check(req, { upgrade = false } = {}) {
    const allowed = norm(getAllowedLogin && getAllowedLogin());
    const dns = normHost(getDnsName && getDnsName());
    if (!allowed) return 'no allowed login configured';
    if (!dns) return 'no tailnet name known';

    const login = header(req, 'tailscale-user-login');
    if (login == null || norm(login) !== allowed) return 'login';

    const port = Number(getPort && getPort()) || null;
    const hosts = new Set([dns]);
    if (port) hosts.add(`${dns}:${port}`);
    if (port === 443 || !port) hosts.add(`${dns}:443`);
    const host = header(req, 'host');
    if (host == null || !hosts.has(normHost(host))) return 'host';

    const origins = new Set([`https://${dns}`]);
    if (port) origins.add(`https://${dns}:${port}`);
    const origin = header(req, 'origin');
    if (upgrade) {
      if (origin == null || !origins.has(norm(origin))) return 'origin';
    } else if (origin != null && !origins.has(norm(origin))) {
      return 'origin';
    }
    return null;
  }

  return { check };
}

/** The one refusal: same bytes whatever failed. */
const FORBIDDEN_BODY = 'Forbidden';

function refuseHttp(res) {
  res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': FORBIDDEN_BODY.length, 'Cache-Control': 'no-store' });
  res.end(FORBIDDEN_BODY);
}

function refuseUpgrade(socket) {
  try {
    socket.end(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${FORBIDDEN_BODY.length}\r\n\r\n${FORBIDDEN_BODY}`);
  } catch (_) { /* gone */ }
}

module.exports = { createAuth, refuseHttp, refuseUpgrade };
