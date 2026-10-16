#!/usr/bin/env node
/**
 * termilab-cli: Termilab's agent API from a shell, for bots and scripts that do
 * not speak MCP. Same socket, same rules as the MCP server (mcp.js): the caller
 * names a host, the running Termilab connects with the credentials it holds.
 *
 *   termilab-cli hosts [--json]
 *   termilab-cli run [--timeout S] [--cwd DIR] [--json] <host> <command...>
 *   termilab-cli read [--json] <host> <path>
 *   termilab-cli write [--mode 644] [--json] <host> <path>   (content on stdin)
 *   termilab-cli mcp                                          (the MCP server)
 *   termilab-cli guide                                        (the agent guide)
 *
 * Run it: /usr/bin/termilab-cli (deb/pacman), `<termilab binary> --cli ...`
 * (any package), `node electron/agent/cli.js ...` (source checkout).
 *
 * Exit codes: `run` passes the remote exit code through (124 on timeout,
 * 128+N when killed by signal N); 125 when the command could not be run at all.
 * Other commands: 0 ok, 1 failure. 2 is always a usage error.
 * Node built-ins only.
 */
const os = require('os');
const { callTermilab, runTimeoutMs } = require('./client');

const EXIT_USAGE = 2;
const EXIT_RUN_FAILED = 125;
const EXIT_TIMEOUT = 124;
const READ_MAX = 4 * 1024 * 1024;   // agent-service LIMITS.readMax / writeMax

const HELP = {
  main: `termilab-cli: use the hosts saved in a running Termilab from scripts and bots.
Credentials stay inside Termilab; this command never sees them.

Usage:
  termilab-cli hosts [--json]                       List the saved hosts
  termilab-cli run <host> <command...>              Run a command, exit with its exit code
  termilab-cli read <host> <path>                   Print a file to stdout
  termilab-cli write <host> <path> [--mode 644]     Write stdin to a file
  termilab-cli mcp                                  Run the MCP server on stdio
  termilab-cli guide                                Print the guide for AI agents
  termilab-cli help <command>                       Help for one command

<host> is a name or id from \`termilab-cli hosts\`, or "local" for this computer.
Termilab must be open. A host whose key Termilab has not trusted yet must be
connected to once from Termilab first.

Run \`termilab-cli guide\` for how AI agents should use this.
`,
  hosts: `Usage: termilab-cli hosts [--json]

List the hosts saved in Termilab: name, group, user@host:port and OS.
  --json   Print the full list as JSON (never includes credentials)
`,
  run: `Usage: termilab-cli run [options] <host> <command...>

Run one command on <host> over a fresh SSH login as that host's user (or in your
login shell for "local"). When it finishes, its stdout and stderr are printed to
stdout and stderr, and termilab-cli exits with the command's exit code.

Options go before the command. After <host>, the first word that is not an
option starts the command, and everything from there on is passed through
untouched (so \`run web ls -la\` works):
  --timeout S   Kill the command after S seconds (default 60, max 3600); exit 124
  --cwd DIR     Run in DIR (absolute, or ~/relative). Default: the home directory
  --json        Print the full result object as JSON instead of the output
  --            End of options

Words after <host> are joined with spaces and run by the remote login shell,
like ssh. Quote the whole command to keep pipes and redirections remote:
  termilab-cli run web "journalctl -u nginx -n 50 | grep error"

Exit codes: the command's own; 124 timeout; 128+N killed by signal N;
125 the command could not be run (Termilab closed, unknown host, host key).
Output is capped at 256 KB per stream; a note on stderr says when it was cut.
`,
  read: `Usage: termilab-cli read [--json] [--max-bytes N] <host> <path>

Print a file from <host> (over SFTP, or locally for "local") to stdout, byte for
byte. <path> is absolute or relative to the home directory (~ allowed).
  --max-bytes N   Read at most N bytes (default and maximum 4 MB); exit 1 if cut
  --json          Print { host, path, size, truncated, encoding, content }
`,
  write: `Usage: termilab-cli write [--mode 644] [--json] <host> <path>

Create or overwrite a file on <host> with what comes on stdin (up to 4 MB).
  --mode OCT   Set the permissions, e.g. 600 or 0644
  --json       Print { host, path, bytes_written }
Example:
  termilab-cli write --mode 644 web /etc/motd < motd.txt
`,
  guide: `Usage: termilab-cli guide

Print the guide for AI agents (Markdown): the workflow, every action with
examples, and what each error means. The MCP server serves the same text as
the resource termilab://guide.
`,
  mcp: `Usage: termilab-cli mcp

Run Termilab's MCP server on stdin/stdout (newline-delimited JSON-RPC), the same
server as termilab-mcp. Register it in an MCP client, for example:
  claude mcp add --scope user termilab -- termilab-cli mcp
`,
};

class UsageError extends Error {}

/** Leading options of a subcommand; stops at the first positional once `maxPos` are taken. */
function parseArgs(argv, spec, { restAfter = Infinity } = {}) {
  const opts = {};
  const pos = [];
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (pos.length >= restAfter) break;
    if (a === '--') { i++; break; }
    if (a === '-h' || a === '--help') { opts.help = true; continue; }
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (!(name in spec)) throw new UsageError(`Unknown option --${name}.`);
      if (spec[name] === 'flag') {
        if (eq > 0) throw new UsageError(`--${name} takes no value.`);
        opts[name] = true;
      } else {
        const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
        if (v === undefined || v === '') throw new UsageError(`--${name} needs a value.`);
        opts[name] = v;
      }
      continue;
    }
    pos.push(a);
  }
  return { opts, pos, rest: argv.slice(i) };
}

/* ── Output helpers ───────────────────────────────────────── */

const out = (s) => process.stdout.write(s);
const err = (s) => process.stderr.write(s.endsWith('\n') ? s : `${s}\n`);
const printJson = (v) => out(`${JSON.stringify(v, null, 2)}\n`);

function table(rows, headers) {
  const all = [headers, ...rows];
  const w = headers.map((_, c) => Math.max(...all.map(r => String(r[c]).length)));
  return all.map(r => r.map((v, c) => (c === r.length - 1 ? String(v) : String(v).padEnd(w[c]))).join('  ').trimEnd()).join('\n');
}

function target(h) {
  const where = h.hostname ? `${h.user ? `${h.user}@` : ''}${h.hostname}${h.port ? `:${h.port}` : ''}` : '';
  return where || '-';
}

/* ── Unknown host: suggest close names ────────────────────── */

function distance(a, b) {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[b.length];
}

async function suggestions(want) {
  let hosts;
  try { hosts = (await callTermilab('list_hosts', {})).hosts || []; } catch (_) { return []; }
  const w = String(want).toLowerCase();
  const scored = [];
  for (const h of hosts) {
    const names = [h.name, h.hostname].filter(Boolean).map(String);
    let best = Infinity;
    for (const n of names) {
      const l = n.toLowerCase();
      const s = (l.includes(w) || w.includes(l)) ? 0 : distance(w, l);
      best = Math.min(best, s);
    }
    if (best <= Math.max(2, Math.floor(w.length / 3))) scored.push([best, h.name]);
  }
  return [...new Set(scored.sort((a, b) => a[0] - b[0]).map(s => s[1]))].slice(0, 3);
}

/* An error from Termilab, worded for a person or a bot log. */
async function explain(e, host) {
  if (e.code === 'not-found' && host) {
    const s = await suggestions(host);
    const tail = s.length ? ` Did you mean: ${s.map(n => `"${n}"`).join(', ')}?` : '';
    return `termilab-cli: no host named "${host}" in Termilab.${tail} Run \`termilab-cli hosts\` for the list.`;
  }
  if (e.code === 'host-key') return `termilab-cli: ${e.message}`;
  return `termilab-cli: ${e.message}`;
}

/* ── Commands ─────────────────────────────────────────────── */

async function cmdHosts(argv) {
  const { opts, pos } = parseArgs(argv, { json: 'flag' });
  if (opts.help) { out(HELP.hosts); return 0; }
  if (pos.length) throw new UsageError(`hosts takes no arguments (got "${pos[0]}").`);
  const { hosts } = await callTermilab('list_hosts', {});
  if (opts.json) { printJson({ hosts }); return 0; }
  const rows = hosts.map(h => [h.name + (h.available === false ? ' (unavailable)' : ''), h.group || '-', target(h), h.os || '-']);
  out(`${table(rows, ['NAME', 'GROUP', 'TARGET', 'OS'])}\n`);
  for (const h of hosts) if (h.available === false && h.note) err(`${h.name}: ${h.note}`);
  return 0;
}

function signalExit(sig) {
  const n = sig && os.constants.signals[sig.startsWith('SIG') ? sig : `SIG${sig}`];
  return n ? 128 + n : 1;
}

async function cmdRun(argv) {
  const { opts, pos, rest } = parseArgs(argv, { timeout: 'value', cwd: 'value', json: 'flag' }, { restAfter: 2 });
  if (opts.help) { out(HELP.run); return 0; }
  const [host, ...words] = [...pos, ...rest];
  if (!host) throw new UsageError('run needs a host and a command.');
  if (!words.length) throw new UsageError(`run needs a command to run on "${host}".`);
  const params = { host, command: words.join(' ') };
  if (opts.timeout !== undefined) {
    const t = Number(opts.timeout);
    if (!Number.isFinite(t) || t <= 0) throw new UsageError('--timeout must be a positive number of seconds.');
    params.timeout_s = t;
  }
  if (opts.cwd !== undefined) params.cwd = opts.cwd;
  let r;
  try {
    r = await callTermilab('run_command', params, { timeoutMs: runTimeoutMs(params.timeout_s) });
  } catch (e) {
    err(await explain(e, host));
    return EXIT_RUN_FAILED;
  }
  const code = r.timed_out ? EXIT_TIMEOUT
    : typeof r.exit_code === 'number' ? r.exit_code
      : r.signal ? signalExit(r.signal) : 1;
  if (opts.json) { printJson(r); return code; }
  if (r.stdout) out(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.truncated) err(`termilab-cli: output cut at 256 KB per stream (stdout ${r.stdout_bytes} bytes, stderr ${r.stderr_bytes} bytes).`);
  if (r.timed_out) err(`termilab-cli: timed out after ${params.timeout_s || 60} s; the command was killed.`);
  return code;
}

async function cmdRead(argv) {
  const { opts, pos } = parseArgs(argv, { json: 'flag', 'max-bytes': 'value' });
  if (opts.help) { out(HELP.read); return 0; }
  const [host, file, extra] = pos;
  if (!host || !file) throw new UsageError('read needs a host and a path.');
  if (extra !== undefined) throw new UsageError(`read takes one path (got "${extra}" too).`);
  let max = READ_MAX;
  if (opts['max-bytes'] !== undefined) {
    max = Number(opts['max-bytes']);
    if (!Number.isInteger(max) || max <= 0) throw new UsageError('--max-bytes must be a positive integer.');
    max = Math.min(max, READ_MAX);
  }
  let r;
  try { r = await callTermilab('read_file', { host, path: file, max_bytes: max }); } catch (e) {
    err(await explain(e, host));
    return 1;
  }
  if (opts.json) { printJson(r); return r.truncated ? 1 : 0; }
  out(Buffer.from(r.content, r.encoding === 'base64' ? 'base64' : 'utf-8'));
  if (r.truncated) { err(`termilab-cli: ${r.path} is ${r.size} bytes; printed only the first ${max}.`); return 1; }
  return 0;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    process.stdin.on('data', (d) => {
      n += d.length;
      if (n > READ_MAX) { reject(new UsageError(`stdin is larger than ${READ_MAX} bytes (the write limit).`)); process.stdin.destroy(); return; }
      chunks.push(d);
    });
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
    process.stdin.on('error', reject);
  });
}

async function cmdWrite(argv) {
  const { opts, pos } = parseArgs(argv, { mode: 'value', json: 'flag' });
  if (opts.help) { out(HELP.write); return 0; }
  const [host, file, extra] = pos;
  if (!host || !file) throw new UsageError('write needs a host and a path; the content comes on stdin.');
  if (extra !== undefined) throw new UsageError(`write takes one path (got "${extra}" too); the content comes on stdin.`);
  if (opts.mode !== undefined && !/^0?[0-7]{3,4}$/.test(opts.mode)) throw new UsageError(`--mode must be octal, like 644 (got "${opts.mode}").`);
  if (process.stdin.isTTY) err('termilab-cli: reading the content from the terminal; end it with Ctrl-D.');
  const data = await readStdin();
  const params = { host, path: file, content: data.toString('base64'), encoding: 'base64' };
  if (opts.mode !== undefined) params.mode = opts.mode;
  let r;
  try { r = await callTermilab('write_file', params); } catch (e) {
    err(await explain(e, host));
    return 1;
  }
  if (opts.json) printJson(r);
  return 0;
}

const COMMANDS = { hosts: cmdHosts, run: cmdRun, read: cmdRead, write: cmdWrite };

async function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  if (!cmd) { process.stderr.write(HELP.main); return EXIT_USAGE; }
  if (cmd === '-h' || cmd === '--help') { out(HELP.main); return 0; }
  if (cmd === 'help') {
    const topic = rest[0];
    if (!topic) { out(HELP.main); return 0; }
    if (!HELP[topic] || topic === 'main') { err(`termilab-cli: no command "${topic}". Commands: hosts, run, read, write, mcp, guide.`); return EXIT_USAGE; }
    out(HELP[topic]);
    return 0;
  }
  if (cmd === '--version' || cmd === '-V') {
    let v = '0';
    try { v = require('../../package.json').version; } catch (_) { /* unknown */ }
    out(`termilab-cli ${v}\n`);
    return 0;
  }
  if (cmd === 'guide') {
    if (rest.includes('--help') || rest.includes('-h')) { out(HELP.guide); return 0; }
    out(require('./guide').GUIDE);
    return 0;
  }
  if (cmd === 'mcp') {
    if (rest.includes('--help') || rest.includes('-h')) { out(HELP.mcp); return 0; }
    require('./mcp').main();
    return null;   // the MCP server owns the process from here
  }
  const fn = COMMANDS[cmd];
  if (!fn) {
    err(`termilab-cli: unknown command "${cmd}". Commands: hosts, run, read, write, mcp, guide. See termilab-cli --help.`);
    return EXIT_USAGE;
  }
  try {
    return await fn(rest);
  } catch (e) {
    if (e instanceof UsageError) {
      err(`termilab-cli ${cmd}: ${e.message}\nSee termilab-cli help ${cmd}.`);
      return EXIT_USAGE;
    }
    err(await explain(e));
    return cmd === 'run' ? EXIT_RUN_FAILED : 1;
  }
}

module.exports = { main, parseArgs };

if (require.main === module) {
  process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); });
  main().then((code) => {
    /* exitCode, not exit(): let stdout drain into a pipe first */
    if (code !== null) process.exitCode = code;
  }, (e) => {
    err(`termilab-cli: ${e.message || e}`);
    process.exitCode = 1;
  });
}
