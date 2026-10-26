/**
 * Agent to agent, second check for LOCAL terminals (agent-talk.js): before a
 * message is typed into a terminal of this computer, /proc must show a live
 * agent CLI (claude, codex, aider, gemini...) in the FOREGROUND process group
 * of that terminal's tty. A Claude that already exited, a `cat` of a text with
 * Claude's footer or an old banner leave the screen looking like an agent, but
 * then the foreground is the shell and nothing is typed.
 *
 * What each check covers:
 *   - the renderer's cursor rule (agentRules.talkInputAt): every terminal,
 *     SSH included; the xterm cursor must sit on the agent's input row.
 *   - this one: local terminals whose shell pid is known (a direct pty, a
 *     kept session via the keeper's `list`, a systemd-run unit's MainPID).
 *     When the pid cannot be found the cursor rule alone decides.
 *
 * Also `pidUnder(pid, root)`: is that process (the caller's parent, sent by
 * termilab-cli / termilab-mcp) inside a terminal's process tree? Used for
 * "never to itself" when the sender has no TERMILAB_SESSION_ID.
 *
 * Linux only (/proc); elsewhere every answer is "unknown". Node built-ins.
 */
const fs = require('fs');
const path = require('path');

/* argv[0..] basenames that are an agent CLI. codex's native binary is
   "codex-x86_64-unknown-linux-musl" in some installs. */
const AGENT_BIN = /^(claude|codex|aider|gemini|opencode|qwen|crush|goose|amp|cursor-agent)$|^(codex)-(x86_64|aarch64|arm64)\b/i;
/* argv[0] that runs a script: the agent is its first non-option argument */
const INTERPRETER = /^(node|nodejs|bun|deno|python[\d.]*|pypy[\d.]*)$/;
/* npm packages run by a plain `node cli.js` */
const AGENT_PKG = /node_modules\/(@anthropic-ai\/claude-code|@openai\/codex|@google\/gemini-cli|opencode-ai|@qwen-code\/qwen-code)\//;

/** {pid, comm, ppid, pgrp, session, ttyNr, tpgid} from /proc/<pid>/stat, or null */
function readStat(pid, procRoot = '/proc') {
  let s;
  try { s = fs.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf-8'); } catch (_) { return null; }
  const open = s.indexOf('(');
  const close = s.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const f = s.slice(close + 2).split(' ');
  /* after "pid (comm) ": state ppid pgrp session tty_nr tpgid ... */
  const n = (i) => Number(f[i]);
  return { pid: Number(pid), comm: s.slice(open + 1, close), state: f[0], ppid: n(1), pgrp: n(2), session: n(3), ttyNr: n(4), tpgid: n(5) };
}

function readArgv(pid, procRoot = '/proc') {
  try {
    return fs.readFileSync(path.join(procRoot, String(pid), 'cmdline'), 'utf-8').split('\0').filter(Boolean);
  } catch (_) { return []; }
}

/** The agent a command line runs ("claude", "codex"...), or null */
function agentOf(argv, comm = '') {
  /* Only what the process IS (its name, argv[0], the script an interpreter
     runs), never its other arguments: `vim claude.md` is no agent */
  const names = [comm, argv[0]];
  if (argv[0] && INTERPRETER.test(path.basename(argv[0]))) {
    const script = argv.slice(1).find(a => !a.startsWith('-'));
    if (script) names.push(script);
  }
  for (const a of names) {
    if (typeof a !== 'string' || !a) continue;
    if (AGENT_PKG.test(a)) return AGENT_PKG.exec(a)[1].replace(/^@[^/]+\//, '').replace(/-code$|-cli$|-ai$/, '');
    const base = path.basename(a).replace(/\.(m?js|cjs|py)$/, '');
    const m = AGENT_BIN.exec(base);
    if (m) return (m[1] || m[2]).toLowerCase();
  }
  return null;
}

function listPids(procRoot = '/proc') {
  try { return fs.readdirSync(procRoot).filter(n => /^\d+$/.test(n)).map(Number); } catch (_) { return null; }
}

/**
 * Is an agent CLI in the foreground of the terminal whose shell is `shellPid`?
 * → {known: false, why} | {known: true, ok: true, agent, pid} | {known: true, ok: false, fg}
 */
function foregroundAgent(shellPid, { procRoot = '/proc' } = {}) {
  if (!Number.isInteger(shellPid) || shellPid <= 1) return { known: false, why: 'no shell pid' };
  const sh = readStat(shellPid, procRoot);
  if (!sh) return { known: false, why: 'the shell is gone or /proc is not readable' };
  if (!(sh.tpgid > 0)) return { known: false, why: 'the shell has no controlling terminal' };
  const pids = listPids(procRoot);
  if (!pids) return { known: false, why: '/proc is not readable' };
  let fgName = null;
  for (const pid of pids) {
    const st = readStat(pid, procRoot);
    if (!st || st.pgrp !== sh.tpgid || st.session !== sh.session) continue;
    if (st.state === 'Z') continue;
    const argv = readArgv(pid, procRoot);
    const agent = agentOf(argv, st.comm);
    if (agent) return { known: true, ok: true, agent, pid };
    if (pid === sh.tpgid || !fgName) fgName = st.comm;
  }
  return { known: true, ok: false, fg: fgName };
}

/** Is `pid` `root` or one of its descendants? true / false, null = unknown */
function pidUnder(pid, root, { procRoot = '/proc' } = {}) {
  if (!Number.isInteger(pid) || pid <= 1 || !Number.isInteger(root) || root <= 1) return null;
  let cur = pid;
  for (let i = 0; i < 128 && cur > 1; i++) {
    if (cur === root) return true;
    const st = readStat(cur, procRoot);
    if (!st) return i === 0 ? null : false;
    cur = st.ppid;
  }
  return false;
}

module.exports = { foregroundAgent, pidUnder, agentOf, readStat };
