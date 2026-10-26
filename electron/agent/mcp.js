#!/usr/bin/env node
/**
 * termilab-mcp: a stdio MCP server that hands an AI agent's tool calls to a
 * running Termilab over its local agent socket (electron/agent/agent-service.js).
 * The agent never sees a credential: it names a host, Termilab connects.
 *
 * Run it:
 *   termilab-cli mcp          (deb/pacman; cli.js hands over to main() here)
 *   <termilab binary> --mcp   (any package)
 *   node electron/agent/mcp.js (source checkout)
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
const path = require('path');
const readline = require('readline');
const { callTermilab, runTimeoutMs, talkTimeoutMs, closeAll, APPROVAL_WAIT_MS } = require('./client');
const { GUIDE } = require('./guide');

const SERVER_INFO = { name: 'termilab', title: 'Termilab', version: readVersion() };
const MODERN = ['2026-07-28'];
const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SUPPORTED = [...MODERN, ...LEGACY];
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';

/* Modern (2026-07-28) list results must say how long the client may cache
   them: ttlMs + cacheScope. Without them a strict client (Claude Code) rejects
   the whole tools/list and the server shows up as "tools fetch failed". The
   lists are static for a given Termilab version, so an hour is safe; scope is
   private because nothing gains from sharing them across users. */
const LIST_CACHE = Object.freeze({ ttlMs: 60 * 60 * 1000, cacheScope: 'private' });
const listResult = (modern, key, items) =>
  (modern ? { resultType: 'complete', ...LIST_CACHE, [key]: items } : { [key]: items });

const INSTRUCTIONS = [
  'Termilab is the SSH client on the user\'s computer. It runs commands and edits files on the user\'s saved servers '
    + 'with the credentials it already holds: you never see a password or key, do not need one, and must not ask for one.',
  'Workflow:',
  '1. Call list_hosts first. Use a host "name" or "id" from it in every call. "local" is this computer. '
    + 'available:false means the host cannot be used now; relay its note to the user.',
  '2. One-off commands: run_command, e.g. {"host":"produccion","command":"docker ps","cwd":"/srv/app"}. Every call is a '
    + 'fresh session on a shared connection, as that host\'s user: cd, variables and sudo sessions do not carry over, so pass cwd. No terminal: a '
    + 'prompt (sudo password, [Y/n]) hangs until timeout_s (default 60). Output capped at 256 KB per stream; filter remotely.',
  '3. Navigation, multi-step or interactive work (cd, env vars, sudo prompts, [Y/n], deploy scripts): open_shell -> '
    + 'send_input (end each command with "\\n") -> read_output (call again with wait_ms until the output stops growing and '
    + 'the prompt is back) -> answer prompts with send_input -> close_shell. Idle shells close after 15 minutes. '
    + 'If sudo asks for a password, stop and tell the user; never guess one.',
  '4. Files: read_file / write_file over SFTP (paths absolute or ~/relative; 4 MB max; write replaces the whole file).',
  'You act with exactly that host user\'s permissions (root or sudo included): be as careful as the user would be.',
  'Destructive commands need the user\'s approval: recursive deletes of project/home/system dirs, git reset --hard, '
    + 'git clean -fdx, force push to main, DROP/TRUNCATE/DELETE without WHERE, dropdb, FLUSHALL, migrate:fresh, '
    + 'docker volume rm, compose down -v. The call waits (up to 2 min) while Termilab asks '
    + 'the user. "Blocked: ..." = the user said no: do not retry, rephrase or work around it; ask the user.',
  'Errors: "Termilab is not running" -> ask the user to open Termilab. Host key not trusted or CHANGED -> ask the user to '
    + 'connect to that host once from Termilab and check the key; agents can never accept host keys, never work around it. '
    + '"No host named" -> call list_hosts. "matches N hosts" -> use the id. Authentication failed -> the user must fix the '
    + 'host in Termilab.',
  '5. Another AI agent in a Termilab terminal ("ask the sempat session X"): list_sessions, then send_to_session '
    + '{"session":"sempat","message":"X"} returns its reply (timedOut -> wait_reply). Rules: see the guide.',
  'Every call is recorded in Termilab\'s Logs. Full guide: resource termilab://guide.',
].join('\n');

function readVersion() {
  try { return require(path.join(__dirname, '..', '..', 'package.json')).version || '0'; } catch (_) { return '0'; }
}

const HOST = { type: 'string', description: 'Host "name" or "id" from list_hosts (names are case-insensitive), or "local" for this computer. Example: "produccion".' };
const SESSION = { type: 'string', description: 'The session_id returned by open_shell, e.g. "sh_3f9a...".' };
const PATH = { type: 'string', description: 'File path on that host: absolute ("/etc/nginx/nginx.conf") or relative to the home directory ("~/app/.env" or "app/.env").' };
const TOOLS = [
  {
    name: 'list_hosts',
    title: 'List hosts',
    description: 'Call this first. Lists the hosts saved in Termilab plus "local" (this computer): name, id, group, tags, os, user, hostname, port, auth, and available (false = cannot be used now; note says why, tell the user). Use name or id in the other tools. Never includes credentials. Takes no arguments: {}.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'run_command',
    title: 'Run a command',
    description: 'Run one shell command on a host and wait for it: a fresh session on a shared connection, as that host\'s user, each call (local: the user\'s login shell), so cd, variables and sudo sessions do not persist; use cwd. Returns exit_code, stdout, stderr, timed_out, truncated, signal, duration_ms. stdout and stderr are capped at 256 KB each (truncated: true). No terminal: commands that prompt hang until the timeout; use non-interactive flags or open_shell. Destructive commands (recursive delete of a project or home dir, git reset --hard, force push to main, DROP/TRUNCATE, dropdb, migrate:fresh, docker volume rm, compose down -v) wait for the user to approve them in Termilab; "Blocked" means do not retry. Example: {"host":"produccion","command":"docker ps","cwd":"/srv/app"}.',
    inputSchema: {
      type: 'object',
      properties: {
        host: HOST,
        command: { type: 'string', description: 'The command line, run by the login shell of that host; pipes and redirections work. Up to 64 KB. Example: "journalctl -u nginx -n 100 | grep -i error".' },
        timeout_s: { type: 'number', description: 'Seconds before the command is killed and timed_out is true. Default 60, maximum 3600.' },
        cwd: { type: 'string', description: 'Directory to run in: absolute ("/srv/app") or under home ("~/app"). Default: the home directory.' },
      },
      required: ['host', 'command'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'open_shell',
    title: 'Open an interactive shell',
    description: 'Open a persistent interactive shell with a terminal (pty) on a host, for navigation and multi-step or interactive work (cd, environment variables, sudo or [Y/n] prompts, deploy scripts, REPLs). Returns session_id. Then: send_input to type, read_output to see the result, close_shell when done. Closed automatically after 15 minutes without use. Example: {"host":"produccion"}.',
    inputSchema: {
      type: 'object',
      properties: {
        host: HOST,
        cols: { type: 'integer', description: 'Terminal width in columns. Default 120 (20 to 500).' },
        rows: { type: 'integer', description: 'Terminal height in rows. Default 40 (5 to 200).' },
      },
      required: ['host'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'send_input',
    title: 'Type into a shell',
    description: 'Type into a shell opened with open_shell, exactly as keystrokes. End a command with "\\n" to press Enter; "\\u0003" is Ctrl-C, "\\u0004" Ctrl-D. Returns immediately: call read_output to see what happened. A destructive line (same rules as run_command, plus DROP/TRUNCATE/FLUSHALL typed into a database prompt) waits for the user to approve it in Termilab; "Blocked" means do not retry. Example: {"session_id":"sh_...","data":"cd /srv/app && git pull\\n"}.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: SESSION,
        data: { type: 'string', description: 'The keystrokes to send, up to 64 KB. Include "\\n" at the end to run a command or answer a prompt ("y\\n").' },
      },
      required: ['session_id', 'data'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'read_output',
    title: 'Read shell output',
    description: 'Output of a shell from open_shell since the last read (raw terminal text, may include escape codes). Waits up to wait_ms for new output. Call it repeatedly until the output stops growing and the prompt (or a question) is back. closed: true and exit_code once the shell has exited. Up to 1 MB of unread output is kept. Example: {"session_id":"sh_...","wait_ms":3000}.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: SESSION,
        wait_ms: { type: 'integer', description: 'Milliseconds to wait for output to arrive. Default 1000, maximum 30000.' },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'close_shell',
    title: 'Close a shell',
    description: 'Close a shell opened with open_shell (ends whatever runs in it). Do this when the work is done. Example: {"session_id":"sh_..."}.',
    inputSchema: {
      type: 'object',
      properties: { session_id: SESSION },
      required: ['session_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'read_file',
    title: 'Read a file',
    description: 'Read a file on a host over SFTP (local: from this computer\'s disk). Returns content, encoding ("utf-8" for text, "base64" otherwise), size and truncated. Reads the first 256 KB by default (max_bytes up to 4 MB). Example: {"host":"produccion","path":"/etc/nginx/nginx.conf"}.',
    inputSchema: {
      type: 'object',
      properties: {
        host: HOST,
        path: PATH,
        max_bytes: { type: 'integer', description: 'Read at most this many bytes. Default 262144 (256 KB), maximum 4194304 (4 MB).' },
      },
      required: ['host', 'path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'write_file',
    title: 'Write a file',
    description: 'Create or overwrite a whole file on a host over SFTP (local: on this computer). Up to 4 MB. To edit, read_file first, change it, write it back, then verify (e.g. "nginx -t"). Returns bytes_written. Example: {"host":"produccion","path":"~/app/.env","content":"PORT=8080\\n","mode":"600"}.',
    inputSchema: {
      type: 'object',
      properties: {
        host: HOST,
        path: PATH,
        content: { type: 'string', description: 'The complete new content of the file (it replaces what is there), encoded as said by encoding.' },
        encoding: { type: 'string', enum: ['utf-8', 'base64'], description: 'How content is encoded: "utf-8" for text (default) or "base64" for binary data.' },
        mode: { type: 'string', description: 'Permissions as an octal string, e.g. "644" or "600". Default: keep the existing mode, or the server default for a new file.' },
      },
      required: ['host', 'path', 'content'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'list_sessions',
    title: 'List Termilab sessions',
    description: 'The terminals open in Termilab (tabs and Background), to talk to another AI agent running in one of them. Each: session (its alias, or a short id), alias, host ("local" or the host label), agent ("claude", "codex"... or null), state (working, idle, waiting-permission, unknown), reachable (true = send_to_session can message it; note says why not), self (true = the terminal you run in). Takes no arguments: {}.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'send_to_session',
    title: 'Message another agent',
    description: 'Type a message into another Termilab terminal where an AI agent CLI runs (Claude Code, Codex...), as if the user typed it in its input box, and wait for that agent to finish its turn. Returns reply (its answer), state, truncated, timedOut. The message arrives prefixed with [Message from Termilab session "<your alias>"]. Only to sessions with reachable: true in list_sessions: never a plain shell, never your own session, not while it waits for a permission or a question (error, nothing typed). A busy agent queues it (queued: true). Up to 8000 characters; 30 messages per hour per session. On timedOut: true, call wait_reply. Example: {"session":"sempat","message":"Which branch are you on?"}.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'The session\'s alias (case-insensitive) or session name from list_sessions. Example: "sempat".' },
        message: { type: 'string', description: 'What to tell or ask that agent, up to 8000 characters. Self-contained: it does not see your conversation.' },
        wait: { type: 'boolean', description: 'Wait for its turn to end and return the reply. Default true. false: return as soon as it is typed.' },
        timeoutSec: { type: 'number', description: 'Seconds to wait for the reply. Default 600, maximum 3600. Then the result has timedOut: true and what it has written so far.' },
      },
      required: ['session', 'message'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'wait_reply',
    title: 'Wait for an agent\'s reply',
    description: 'Keep waiting for the reply to the last message sent with send_to_session to that session (after timedOut: true, or wait: false). Returns the same fields as send_to_session. Example: {"session":"sempat","timeoutSec":900}.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'The same session as in send_to_session.' },
        timeoutSec: { type: 'number', description: 'Seconds to wait. Default 600, maximum 3600.' },
      },
      required: ['session'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];
const TOOL_NAMES = new Set(TOOLS.map(t => t.name));

/* The full agent guide (guide.js), for clients that read resources or prompts */
const GUIDE_URI = 'termilab://guide';
const RESOURCES = [{
  uri: GUIDE_URI,
  name: 'guide',
  title: 'How to use Termilab as an AI agent',
  description: 'Workflow, tools, examples and error handling for working on the user\'s servers through Termilab.',
  mimeType: 'text/markdown',
}];
const PROMPT_NAME = 'termilab_usage';
const PROMPTS = [{
  name: PROMPT_NAME,
  title: 'Use Termilab',
  description: 'Puts the Termilab agent guide in the conversation: how to list hosts, run commands, use interactive shells and edit files.',
  arguments: [],
}];
const CAPABILITIES = { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } };

/* Talking to Termilab: the shared socket client (client.js) */

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

async function callTool(name, args, client) {
  const a = args && typeof args === 'object' ? args : {};
  /* Termilab enforces its own command timeout; give it room to answer (and the user to approve) */
  const timeoutMs = name === 'run_command' ? runTimeoutMs(a.timeout_s)
    : (name === 'send_to_session' || name === 'wait_reply') ? talkTimeoutMs(name === 'send_to_session' && a.wait === false ? 0 : a.timeoutSec)
      : 120000 + (name === 'send_input' ? APPROVAL_WAIT_MS : 0);
  return callTermilab(name, a, { timeoutMs, client });
}

/* The MCP client's name (initialize clientInfo, or the modern per-request _meta), for the approval prompt */
const CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';
function clientName(info) {
  if (!info || typeof info !== 'object') return null;
  const n = typeof info.title === 'string' && info.title.trim() ? info.title : info.name;
  return typeof n === 'string' && n.trim() ? n.trim().slice(0, 80) : null;
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
      state.client = clientName(params.clientInfo) || state.client || null;
      return ok({ protocolVersion: version, capabilities: CAPABILITIES, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
    }
    case 'server/discover':
      return ok({
        resultType: 'complete',
        supportedVersions: SUPPORTED,
        capabilities: CAPABILITIES,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
        instructions: INSTRUCTIONS,
      });
    case 'ping':
      return ok(modern ? { resultType: 'complete' } : {});
    case 'tools/list':
      return ok(listResult(modern, 'tools', TOOLS));
    case 'resources/list':
      return ok(listResult(modern, 'resources', RESOURCES));
    case 'resources/templates/list':
      return ok(listResult(modern, 'resourceTemplates', []));
    case 'resources/read':
      if (params.uri !== GUIDE_URI) return err(-32002, `Resource not found: ${params.uri}`, { uri: params.uri });
      return ok({ ...(modern ? { resultType: 'complete' } : {}), contents: [{ uri: GUIDE_URI, mimeType: 'text/markdown', text: GUIDE }] });
    case 'prompts/list':
      return ok(listResult(modern, 'prompts', PROMPTS));
    case 'prompts/get':
      if (params.name !== PROMPT_NAME) return err(-32602, `Unknown prompt: ${params.name}`);
      return ok({
        ...(modern ? { resultType: 'complete' } : {}),
        description: PROMPTS[0].description,
        messages: [{ role: 'user', content: { type: 'text', text: `Use the Termilab MCP tools to work on my servers, following this guide.\n\n${GUIDE}` } }],
      });
    case 'tools/call': {
      const name = params.name;
      if (!TOOL_NAMES.has(name)) return err(-32602, `Unknown tool: ${name}`);
      try {
        const client = clientName(meta && meta[CLIENT_INFO]) || state.client || null;
        return ok(toolResult(await callTool(name, params.arguments, client), modern));
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
  closeAll();
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

module.exports = { handle, TOOLS, SUPPORTED, INSTRUCTIONS, main, callTermilab };

if (require.main === module) main();
