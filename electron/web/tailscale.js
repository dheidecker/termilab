/*
 * Tailscale, the only way in for "remote access" (Termilab web mirror).
 *
 * Termilab never listens on a network interface for this: `tailscale serve`
 * terminates HTTPS on this device's tailnet name and proxies to a local
 * target (a 0700 unix socket on Linux, loopback elsewhere). The project is
 * open source, so there must be NO path that exposes the mirror without
 * Tailscale: enable() refuses unless status() says ready, and refuses a port
 * where Funnel (public internet) is on.
 *
 * The serve config is NOT persistent (`--bg` is never used): serve runs in the
 * foreground as a child of electron/web/serve-guard.js, which kills it when
 * Termilab's end of its stdin closes. Quit, crash or kill -9: the config dies
 * with the app, nothing is left pointing at a dead socket.
 *
 * Every invocation is execFile/spawn of the binary itself: no shell, ever.
 * Short commands carry a timeout. disable() never runs `tailscale serve
 * reset`, which would wipe serve config that is not ours.
 *
 * TERMILAB_TAILSCALE_BIN overrides the binary (scripts/check-main.js, TS*).
 */
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

/* Fixed on purpose: later phases find other Termilabs in the tailnet by
   probing this port on each peer. */
const DEFAULT_PORT = 7443;
const EXEC_TIMEOUT_MS = 10000;
const OPERATOR_COMMAND = 'sudo tailscale set --operator=$USER';
const REASONS = ['not-installed', 'stopped', 'logged-out', 'https-disabled', 'tagged'];

class TailscaleError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'TailscaleError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/* ─── Binary ─────────────────────────────────────────────── */

function resolveBinary({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  if (env.TERMILAB_TAILSCALE_BIN) return env.TERMILAB_TAILSCALE_BIN;
  if (platform === 'darwin') {
    for (const p of ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale']) {
      if (exists(p)) return p;
    }
    return 'tailscale';
  }
  if (platform === 'win32') {
    const p = path.win32.join(env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe');
    return exists(p) ? p : 'tailscale.exe';
  }
  return 'tailscale';   // linux and the rest: the PATH
}

/** {code, stdout, stderr}; rejects TailscaleError('not-installed') when the binary is missing. */
function run(args, { timeout = EXEC_TIMEOUT_MS, bin = resolveBinary() } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && (err.code === 'ENOENT' || err.code === 'EACCES')) {
        reject(new TailscaleError('not-installed', 'Tailscale is not installed'));
        return;
      }
      if (err && err.killed) {
        reject(new TailscaleError('timeout', `tailscale ${args[0]} did not answer in time`));
        return;
      }
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

const isAccessDenied = (text) => /access denied|permission denied|not permitted|must be root|--operator/i.test(String(text || ''));

function operatorError() {
  return new TailscaleError('operator-required',
    `Tailscale does not let this user change serve settings. Run once: ${OPERATOR_COMMAND}`,
    { command: OPERATOR_COMMAND });
}

function parseJson(text) {
  try { return JSON.parse(text); } catch (_) { return null; }
}

/* ─── Status ─────────────────────────────────────────────── */

/** Pure: `tailscale status --json` (parsed, or null) → the status object. */
function interpretStatus(json) {
  const out = { installed: true, running: false, login: null, dnsName: null, httpsEnabled: false, tagged: false, reason: null };
  if (!json || typeof json !== 'object') return { ...out, reason: 'stopped' };   // daemon unreachable
  const state = json.BackendState;
  if (state === 'NeedsLogin' || state === 'NeedsMachineAuth' || state === 'NoState') return { ...out, reason: 'logged-out' };
  if (state !== 'Running') return { ...out, reason: 'stopped' };
  const self = json.Self || {};
  const user = json.User && self.UserID != null ? json.User[String(self.UserID)] : null;
  out.running = true;
  out.login = (user && user.LoginName) || null;
  out.dnsName = String(self.DNSName || '').replace(/\.$/, '') || null;
  out.httpsEnabled = Array.isArray(json.CertDomains) && json.CertDomains.length > 0;
  out.tagged = Array.isArray(self.Tags) && self.Tags.length > 0;
  // Tagged: serve sends no Tailscale-User-* identity headers → refused
  if (out.tagged) out.reason = 'tagged';
  else if (!out.httpsEnabled || !out.dnsName) out.reason = 'https-disabled';
  return out;
}

async function status(opts) {
  let r;
  try {
    r = await run(['status', '--json'], opts);
  } catch (err) {
    if (err.code === 'not-installed') {
      return { installed: false, running: false, login: null, dnsName: null, httpsEnabled: false, tagged: false, reason: 'not-installed' };
    }
    return interpretStatus(null);
  }
  // Stopped/NeedsLogin may exit non-zero and still print the JSON
  return interpretStatus(parseJson(r.stdout));
}

/** The raw `tailscale status --json` (parsed), or null when it cannot be read. discovery.js reads Peer from it. */
async function statusJson(opts) {
  try {
    const r = await run(['status', '--json'], opts);
    return parseJson(r.stdout);
  } catch (_) {
    return null;
  }
}

/* ─── Serve config ───────────────────────────────────────── */

async function serveStatus(opts) {
  const r = await run(['serve', 'status', '--json'], opts);
  const text = r.stdout.trim();
  if (!text) return {};
  const json = parseJson(text);
  if (json && typeof json === 'object') return json;
  if (isAccessDenied(r.stdout + r.stderr)) throw operatorError();
  if (r.code !== 0) throw new TailscaleError('serve-status-failed', (r.stderr || r.stdout).trim() || 'tailscale serve status failed');
  return {};   // "No serve config"
}

const sameTarget = (a, b) => String(a || '').replace(/\/+$/, '') === String(b || '').replace(/\/+$/, '');

/**
 * Pure: what is on `port` in a ServeConfig (background config plus every
 * Foreground session's). {used, ours, funnel, foreground}. `ours` = a plain
 * HTTPS proxy of "/" to exactly `target`.
 */
function portUsage(cfg, { port, target }) {
  const res = { used: false, ours: false, funnel: false, foreground: false };
  const p = String(port);
  const suffix = `:${p}`;
  const configs = [[cfg || {}, false]];
  if (cfg && cfg.Foreground && typeof cfg.Foreground === 'object') {
    for (const fg of Object.values(cfg.Foreground)) configs.push([fg || {}, true]);
  }
  for (const [c, fg] of configs) {
    for (const [hp, on] of Object.entries(c.AllowFunnel || {})) {
      if (on && hp.endsWith(suffix)) res.funnel = true;
    }
    const tcp = c.TCP && c.TCP[p];
    const webs = Object.entries(c.Web || {}).filter(([hp]) => hp.endsWith(suffix));
    if (!tcp && !webs.length) continue;
    res.used = true;
    if (fg) res.foreground = true;
    const handlers = webs.length === 1 ? (webs[0][1] && webs[0][1].Handlers) || {} : null;
    const keys = handlers ? Object.keys(handlers) : [];
    const plain = !tcp || (tcp.HTTPS && !tcp.TCPForward);
    if (plain && keys.length === 1 && keys[0] === '/' && sameTarget(handlers['/'].Proxy, target)) res.ours = true;
  }
  return res;
}

function checkPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TailscaleError('bad-port', `Invalid port: ${port}`);
}
/* Only our own kinds of target, and never something that parses as a flag */
function checkTarget(target) {
  if (typeof target !== 'string' || !/^(unix:\/[^\s]+|http:\/\/(127\.0\.0\.1|localhost):\d{1,5})$/.test(target)) {
    throw new TailscaleError('bad-target', `Invalid serve target: ${target}`);
  }
}

/* ─── Socket (Linux) ─────────────────────────────────────── */

function socketPath(userData) {
  return path.join(userData, 'web', 'termilab.sock');
}

function ensureSocketDir(userData) {
  const dir = path.join(userData, 'web');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);   // mkdir's mode is masked by umask and ignored if it existed
  return dir;
}

/* ─── Enable / disable ───────────────────────────────────── */

/**
 * The checks before serving: Tailscale ready, Funnel off on `port`, port
 * free or already ours. Returns {status, usage}; throws TailscaleError.
 */
async function preflight({ port, target }, opts) {
  checkPort(port);
  checkTarget(target);
  const st = await status(opts);
  if (st.reason) throw new TailscaleError(st.reason, `Tailscale is not ready: ${st.reason}`);
  const usage = portUsage(await serveStatus(opts), { port, target });
  if (usage.funnel) {
    throw new TailscaleError('funnel-on', `Tailscale Funnel is on for port ${port}: that would put Termilab on the public internet. Turn Funnel off for that port or pick another one.`);
  }
  if (usage.used && !usage.ours) {
    throw new TailscaleError('port-busy', `Port ${port} of tailscale serve is already used by something else.`);
  }
  if (usage.used && usage.foreground) {
    throw new TailscaleError('port-busy', `Port ${port} is already being served by another running process (another Termilab?).`);
  }
  return { status: st, usage };
}

/**
 * Starts `tailscale serve --https=<port> <target>` in the foreground under
 * serve-guard.js and resolves once serve says it is up (or is still alive
 * after readyMs). Resolves {url, port, pid, stop(), onExit(fn)}; rejects
 * TailscaleError (operator-required by the child's output, serve-failed, ...).
 */
async function enable({ port = DEFAULT_PORT, target, readyMs = 4000 } = {}, opts = {}) {
  const { status: st, usage } = await preflight({ port, target }, opts);
  // A leftover background config of ours (e.g. an old `--bg`): clear it first,
  // a foreground serve does not take a port the background config holds.
  if (usage.used && usage.ours) await run(['serve', `--https=${port}`, 'off'], opts).catch(() => {});

  const bin = opts.bin || resolveBinary();
  const guard = path.join(__dirname, 'serve-guard.js');
  const child = spawn(process.execPath, [guard, bin, 'serve', `--https=${port}`, target], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  let output = '';
  const exitFns = [];
  let exited = null;
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  child.stdin.on('error', () => {});

  const handle = {
    url: `https://${st.dnsName}:${port}/`,
    port,
    pid: child.pid,
    child,
    output: () => output,
    onExit: (fn) => { if (exited) fn(exited); else exitFns.push(fn); },
    /* Close the guard's stdin (it kills serve and exits: works on Windows,
       where a signal would not let it clean up), then force after a grace. */
    stop: () => new Promise((resolve) => {
      if (exited) { resolve(exited); return; }
      exitFns.push(resolve);
      try { child.stdin.end(); } catch (_) { /* gone */ }
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* gone */ } }, 3000);
      if (t.unref) t.unref();
    }),
  };

  await new Promise((resolve, reject) => {
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.removeListener('data', onOut);
      if (err) reject(err); else resolve();
    };
    const onOut = () => { if (/Available|Press Ctrl\+C/i.test(output)) done(); };
    const timer = setTimeout(() => done(), readyMs);
    child.stdout.on('data', onOut);
    child.on('error', (e) => done(new TailscaleError('serve-failed', e.message)));
    child.on('exit', (code, signal) => {
      exited = { code, signal, output };
      for (const fn of exitFns.splice(0)) { try { fn(exited); } catch (_) { /* listener */ } }
      if (isAccessDenied(output)) done(operatorError());
      else done(new TailscaleError('serve-failed', output.trim() || `tailscale serve exited (${code ?? signal})`));
    });
  });
  return handle;
}

/**
 * Defensive cleanup of `port`: `tailscale serve --https=<port> off`, only if
 * what is there is ours (or nothing is there). Never `serve reset`.
 */
async function disable({ port = DEFAULT_PORT, target } = {}, opts = {}) {
  checkPort(port);
  let usage = null;
  try {
    usage = portUsage(await serveStatus(opts), { port, target });
  } catch (err) {
    if (err.code === 'not-installed') return { removed: false };
    usage = null;   // unknown: `off` on a port we were using is still the right cleanup
  }
  if (usage && usage.used && !usage.ours) return { removed: false, reason: 'not-ours' };
  const r = await run(['serve', `--https=${port}`, 'off'], opts);
  if (r.code !== 0 && isAccessDenied(r.stdout + r.stderr)) throw operatorError();
  return { removed: r.code === 0 };
}

module.exports = {
  DEFAULT_PORT, OPERATOR_COMMAND, REASONS, TailscaleError,
  resolveBinary, run, status, statusJson, interpretStatus, serveStatus, portUsage,
  preflight, enable, disable, socketPath, ensureSocketDir, isAccessDenied,
};
