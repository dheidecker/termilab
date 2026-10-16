#!/usr/bin/env node
/**
 * termilab-mcp: a stdio MCP server that hands an AI agent's tool calls to a
 * running Termilab over its local agent socket (electron/agent/agent-service.js).
 * The agent never sees a credential: it names a host, Termilab connects.
 *
 * Run it:
 *   dev:       node electron/agent/mcp.js
 *   packaged:  ELECTRON_RUN_AS_NODE=1 <termilab binary> <resources>/app.asar/electron/agent/mcp.js
 *
 * No dependencies (Node built-ins only). Speaks newline-delimited JSON-RPC 2.0
 * on stdin/stdout, dual-era:
 *   - legacy: `initialize` handshake (2025-11-25 and earlier revisions)
 *   - modern (2026-07-28): `server/discover` and per-request
 *     `_meta["io.modelcontextprotocol/protocolVersion"]`
 * Logs go to stderr only; stdout carries nothing but JSON-RPC.
 *
 * Env: TERMILAB_USER_DATA  Termilab's userData folder (default: the usual one)
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const readline = require('readline');
const { agentPaths, findUserDataDir } = require('./paths');

const SERVER_INFO = { name: 'termilab', title: 'Termilab', version: readVersion() };
const MODERN = ['2026-07-28'];
const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SUPPORTED = [...MODERN, ...LEGACY];
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';

const INSTRUCTIONS = 'Termilab runs commands on the user\'s saved SSH hosts (and on this computer as host "local") '
  + 'with the credentials stored in Termilab; you never see or need them. Call list_hosts first and use a '
  + 'host name or id from it. run_command is for one-shot commands; open_shell/send_input/read_output for '
  + 'interactive programs. A host-key error means the user must connect to that host once from Termilab. '
  + 'Every call is recorded in Termilab\'s Logs.';

function readVersion() {
  try { return require(path.join(__dirname, '..', '..', 'package.json')).version || '0'; } catch (_) { return '0'; }
}

const HOST = { type: 'string', description: 'Host name or id from list_hosts, or "local" for this computer.' };
const TOOLS = [
  {
    name: 'list_hosts',
    title: 'List hosts',
    description: 'The hosts saved in Termilab: name, id, group, tags, os, user, hostname, port and whether it is usable now. Never includes credentials.',
    inputSchema: { type: 'object', additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'run_command',
    title: 'Run a command',
    description: 'Run one shell command on a host over a fresh SSH connection (or locally for "local") and return exit_code, stdout, stderr. Output is capped at 256 KB per stream (truncated: true). No tty: for prompts use open_shell.',
    inputSchema: {
      type: 'object',
      properties: {
        host: HOST,
        command: { type: 'string', description: 'The command line, run by the user\'s login shell on that host.' },
        timeout_s: { type: 'number', description: 'Seconds before the command is killed (default 60, max 3600).' },
        cwd: { type: 'string', description: 'Directory to run in (~ allowed). Default: home.' },
      },
      required: ['host', 'command'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  {
    name: 'open_shell',
    title: 'Open an interactive shell',
    description: 'Open an interactive shell (with a pty) on a host. Returns session_id. Closed after 15 minutes without use.',
    inputSchema: {
      type: 'object',
      properties: { host: HOST, cols: { type: 'integer' }, rows: { type: 'integer' } },
      required: ['host'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  {
    name: 'send_input',
    title: 'Type into a shell',
    description: 'Send keystrokes to an open shell. Include "\\r" (or "\\n") to press Enter; "\\u0003" is Ctrl-C.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' }, data: { type: 'string' } },
      required: ['session_id', 'data'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true },
  },
  {
    name: 'read_output',
    title: 'Read shell output',
    description: 'Output of an open shell since the last read (raw terminal text, may include escape codes). Waits up to wait_ms (default 1000, max 30000) for output to arrive. closed: true once the shell exited.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' }, wait_ms: { type: 'integer' } },
      required: ['session_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'close_shell',
    title: 'Close a shell',
    description: 'Close an interactive shell opened with open_shell.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    title: 'Read a file',
    description: 'Read a file on a host over SFTP (or locally). Text comes back as utf-8, anything else as base64 (see encoding). Default cap 256 KB (max_bytes up to 4 MB).',
    inputSchema: {
      type: 'object',
      properties: { host: HOST, path: { type: 'string', description: 'Absolute, or relative to home (~ allowed).' }, max_bytes: { type: 'integer' } },
      required: ['host', 'path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'write_file',
    title: 'Write a file',
    description: 'Create or overwrite a file on a host over SFTP (or locally). Up to 4 MB. mode is octal, e.g. "644".',
    inputSchema: {
      type: 'object',
      properties: {
        host: HOST,
        path: { type: 'string', description: 'Absolute, or relative to home (~ allowed).' },
        content: { type: 'string' },
        encoding: { type: 'string', enum: ['utf-8', 'base64'], description: 'How content is encoded (default utf-8).' },
        mode: { type: 'string', description: 'Permissions in octal, e.g. "600".' },
      },
      required: ['host', 'path', 'content'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
];
const TOOL_NAMES = new Set(TOOLS.map(t => t.name));

const NOT_RUNNING = 'Termilab is not running. Open Termilab first, then try again.';

/* ── Talking to Termilab ──────────────────────────────────── */

let seq = 0;
/** Sockets to Termilab still open: closed when we exit (stdin ended, signal). */
const openSockets = new Set();
function callTermilab(method, params, { timeoutMs = 120000 } = {}) {
  const dir = findUserDataDir();
  const p = agentPaths(dir);
  let token;
  try {
    token = fs.readFileSync(p.token, 'utf-8').trim();
  } catch (_) {
    return Promise.reject(new Error(NOT_RUNNING));
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
    const timer = setTimeout(() => done(new Error('Termilab did not answer in time.')), timeoutMs);
    sock.setEncoding('utf-8');
    sock.on('connect', () => sock.write(`${JSON.stringify({ id, token, method, params })}\n`));
    sock.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let msg;
      try { msg = JSON.parse(buf.slice(0, nl)); } catch (_) { done(new Error('Bad answer from Termilab.')); return; }
      if (msg.error) done(new Error(msg.error.message || 'Termilab refused the request.'));
      else done(null, msg.result);
    });
    sock.on('error', (err) => {
      if (['ENOENT', 'ECONNREFUSED', 'ENOTSOCK', 'EPIPE'].includes(err.code)) done(new Error(NOT_RUNNING));
      else done(new Error(`Could not reach Termilab: ${err.message}`));
    });
    sock.on('close', () => done(new Error('Termilab closed the connection.')));
  });
}

/* ── MCP ──────────────────────────────────────────────────── */

const toolResult = (data, modern) => ({
  ...(modern ? { resultType: 'complete' } : {}),
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  structuredContent: data,
  isError: false,
});
const toolError = (message, modern) => ({
  ...(modern ? { resultType: 'complete' } : {}),
  content: [{ type: 'text', text: message }],
  isError: true,
});

async function callTool(name, args) {
  const a = args && typeof args === 'object' ? args : {};
  /* Termilab enforces its own command timeout; give it room to answer */
  const secs = Number(a.timeout_s) > 0 ? Math.min(Number(a.timeout_s), 3600) : 60;
  const timeoutMs = name === 'run_command' ? (secs + 60) * 1000 : 120000;
  return callTermilab(name, a, { timeoutMs });
}

/**
 * One JSON-RPC message -> the response object, or null for notifications.
 * Exported for the harness.
 */
async function handle(msg, state = {}) {
  const isRequest = msg && typeof msg === 'object' && 'id' in msg && msg.id !== null && typeof msg.method === 'string';
  if (!isRequest) return null;   // notifications (initialized, cancelled) and stray responses
  const { id, method } = msg;
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
  const meta = params._meta && typeof params._meta === 'object' ? params._meta : null;
  const asked = meta && meta[META_VERSION];
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const err = (code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });

  if (asked !== undefined && asked !== null && !SUPPORTED.includes(asked)) {
    return err(-32022, 'Unsupported protocol version', { supported: SUPPORTED, requested: asked });
  }
  const modern = !!asked && MODERN.includes(asked);

  switch (method) {
    case 'initialize': {
      const want = params.protocolVersion;
      const version = LEGACY.includes(want) ? want : LEGACY[0];
      state.version = version;
      return ok({ protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
    }
    case 'server/discover':
      return ok({
        resultType: 'complete',
        supportedVersions: SUPPORTED,
        capabilities: { tools: {} },
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
        instructions: INSTRUCTIONS,
      });
    case 'ping':
      return ok(modern ? { resultType: 'complete' } : {});
    case 'tools/list':
      return ok({ ...(modern ? { resultType: 'complete' } : {}), tools: TOOLS });
    case 'tools/call': {
      const name = params.name;
      if (!TOOL_NAMES.has(name)) return err(-32602, `Unknown tool: ${name}`);
      try {
        return ok(toolResult(await callTool(name, params.arguments), modern));
      } catch (e) {
        return ok(toolError(e.message || String(e), modern));
      }
    }
    default:
      return err(-32601, `Method not found: ${method}`);
  }
}

/* The client went away (stdin ended) or we were told to stop: drop what is in
   flight and leave now, so a dead parent never leaves us behind. */
function shutdown(code = 0) {
  for (const s of openSockets) { try { s.destroy(); } catch (_) { /* gone */ } }
  openSockets.clear();
  process.exit(code);
}

function main() {
  /* stdout is the JSON-RPC channel: anything else that prints goes to stderr */
  const toErr = (...a) => process.stderr.write(`${a.map(String).join(' ')}\n`);
  console.log = toErr; console.info = toErr; console.debug = toErr; console.warn = toErr;
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => shutdown(0));
  process.stdin.on('end', () => shutdown(0));
  process.stdin.on('error', () => shutdown(0));
  const state = {};
  const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch (_) {
      out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const batch = Array.isArray(msg) ? msg : [msg];
    for (const m of batch) {
      handle(m, state)
        .then((res) => { if (res) out(res); })
        .catch((e) => { if (m && m.id !== undefined) out({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: e.message } }); });
    }
  });
  rl.on('close', () => shutdown(0));
  process.stdout.on('error', () => shutdown(0));
}

module.exports = { handle, TOOLS, SUPPORTED, main, callTermilab };

if (require.main === module) main();
