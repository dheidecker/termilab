/**
 * The one client for Termilab's local agent socket (agent-service.js), shared
 * by the MCP server (mcp.js) and the command line (cli.js). Node built-ins
 * only, no `electron`: both run in plain node mode.
 *
 * callTermilab(method, params) resolves with the method's result or rejects
 * with an Error whose `code` is the service's (`not-found`, `host-key`, `auth`,
 * `invalid`, ...) or `not-running` when no Termilab answers.
 */
const fs = require('fs');
const net = require('net');
const { agentPaths, findUserDataDir } = require('./paths');

const NOT_RUNNING = 'Termilab is not running. Open Termilab first, then try again.';

const codedError = (code, message) => Object.assign(new Error(message), { code });

let seq = 0;
/** Sockets to Termilab still open: closeAll() drops them (stdin ended, signal). */
const openSockets = new Set();

function callTermilab(method, params, { timeoutMs = 120000, client = null } = {}) {
  const p = agentPaths(findUserDataDir());
  let token;
  try {
    token = fs.readFileSync(p.token, 'utf-8').trim();
  } catch (_) {
    return Promise.reject(codedError('not-running', NOT_RUNNING));
  }
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const sock = net.connect(p.socket);
    openSockets.add(sock);
    sock.on('close', () => openSockets.delete(sock));
    let buf = '';
    let settled = false;
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err); else resolve(val);
    };
    const timer = setTimeout(() => done(codedError('timeout', 'Termilab did not answer in time.')), timeoutMs);
    sock.setEncoding('utf-8');
    /* client: who is asking (MCP clientInfo name, "termilab-cli"), shown when the user must approve */
    /* from: the Termilab terminal this runs in (local shells export it), the sender of send_to_session */
    const from = typeof process.env.TERMILAB_SESSION_ID === 'string' && process.env.TERMILAB_SESSION_ID ? process.env.TERMILAB_SESSION_ID : null;
    sock.on('connect', () => sock.write(`${JSON.stringify({ id, token, method, params, ...(client ? { client } : {}), ...(from ? { from } : {}) })}\n`));
    sock.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let msg;
      try { msg = JSON.parse(buf.slice(0, nl)); } catch (_) { done(codedError('protocol', 'Bad answer from Termilab.')); return; }
      if (msg.error) done(codedError(msg.error.code || 'error', msg.error.message || 'Termilab refused the request.'));
      else done(null, msg.result);
    });
    sock.on('error', (err) => {
      if (['ENOENT', 'ECONNREFUSED', 'ENOTSOCK', 'EPIPE'].includes(err.code)) done(codedError('not-running', NOT_RUNNING));
      else done(codedError('unreachable', `Could not reach Termilab: ${err.message}`));
    });
    sock.on('close', () => done(codedError('closed', 'Termilab closed the connection.')));
  });
}

/* A destructive command waits up to this long for the user's Run once / Block in Termilab */
const APPROVAL_WAIT_MS = 120000;

/* How long to wait for run_command: Termilab enforces the command timeout itself. */
function runTimeoutMs(timeoutS) {
  const secs = Number(timeoutS) > 0 ? Math.min(Number(timeoutS), 3600) : 60;
  return (secs + 60) * 1000 + APPROVAL_WAIT_MS;
}

/* send_to_session / wait_reply: Termilab enforces the wait itself (default 600 s, max 3600) */
function talkTimeoutMs(timeoutSec) {
  const n = Number(timeoutSec);
  const secs = timeoutSec === undefined || timeoutSec === null || !Number.isFinite(n) ? 600 : Math.min(Math.max(n, 0), 3600);
  return (secs + 60) * 1000;
}

function closeAll() {
  for (const s of openSockets) { try { s.destroy(); } catch (_) { /* gone */ } }
  openSockets.clear();
}

module.exports = { callTermilab, runTimeoutMs, talkTimeoutMs, closeAll, NOT_RUNNING, APPROVAL_WAIT_MS };
