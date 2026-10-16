/**
 * The local machine as the agent host "local": one command in the user's
 * login shell, or an interactive login shell on a pty.
 *
 * Same escape as local terminals (services/local-shell-escape.js): when
 * Termilab runs with no_new_privs (relaunched by the updater), the command is
 * started by the user's systemd manager instead, so sudo, snap, ping… work.
 * Units are named termilab-agent-<id> (not termilab-shell-*: those are tabs).
 *
 * No `electron` here: scripts/lib/agent-local-driver.js runs it under setpriv.
 */
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const ptyEscape = require('../services/local-shell-escape');

const UNIT_PREFIX = 'termilab-agent-';
const IS_WIN = process.platform === 'win32';

function loginShell() {
  if (IS_WIN) return process.env.ComSpec || 'cmd.exe';
  let shell = '';
  try { shell = os.userInfo().shell || ''; } catch (_) { /* no passwd entry */ }
  return shell || process.env.SHELL || '/bin/sh';
}

/* Termilab's own environment minus what belongs to Electron/Chromium. */
function cleanEnv(extra = {}) {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== 'string') continue;
    if (/^(ELECTRON_|CHROME_|GOOGLE_|VITE_)/.test(k) || k === 'NODE_OPTIONS' || k === 'NODE_PATH') continue;
    out[k] = v;
  }
  return { ...out, ...extra };
}

/** `~`, `~/x` and relative paths against the home folder. */
function resolveLocalPath(p) {
  const home = os.homedir();
  if (!p || p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return path.isAbsolute(p) ? p : path.join(home, p);
}

const unitFor = () => `${UNIT_PREFIX}${crypto.randomBytes(6).toString('hex')}`;

function stopUnit(unit) {
  try {
    spawn('systemctl', ['--user', 'stop', '--no-block', `${unit}.service`], { stdio: 'ignore' }).on('error', () => {});
  } catch (_) { /* best effort */ }
}

/**
 * Run `command` locally. Resolves
 *   { exit_code, signal, stdout, stderr, truncated, timed_out, stdout_bytes, stderr_bytes }
 */
async function runLocal({ command, cwd, timeoutMs = 60000, maxBytes = 256 * 1024 }) {
  const dir = resolveLocalPath(cwd);
  const shell = loginShell();
  const decision = IS_WIN ? { mode: 'direct' } : await ptyEscape.launchDecision();
  let file; let args; let unit = null;
  if (IS_WIN) {
    file = shell; args = ['/d', '/s', '/c', command];
  } else if (decision.mode === 'systemd-run') {
    unit = unitFor();
    file = decision.systemdRun;
    args = ['--user', '--pipe', '--quiet', '--collect', '--wait', '--same-dir', `--unit=${unit}`];
    for (const [k, v] of Object.entries(ptyEscape.filterEnv(process.env, {}))) args.push(`--setenv=${k}=${v}`);
    args.push('--', shell, '-lc', command);
  } else {
    file = shell; args = ['-lc', command];
  }

  return new Promise((resolve, reject) => {
    const out = { stdout: [], stderr: [] };
    const len = { stdout: 0, stderr: 0 };
    const total = { stdout: 0, stderr: 0 };
    let timedOut = false;
    let child;
    try {
      child = spawn(file, args, { cwd: dir, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: !IS_WIN, windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }
    const take = (name) => (d) => {
      total[name] += d.length;
      const room = maxBytes - len[name];
      if (room <= 0) return;
      const part = d.length > room ? d.subarray(0, room) : d;
      out[name].push(part);
      len[name] += part.length;
    };
    child.stdout.on('data', take('stdout'));
    child.stderr.on('data', take('stderr'));
    const kill = (sig) => {
      try {
        if (IS_WIN) child.kill(sig);
        else process.kill(-child.pid, sig);
      } catch (_) { /* gone */ }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (unit) stopUnit(unit);
      kill('SIGTERM');
      setTimeout(() => kill('SIGKILL'), 2000).unref();
    }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        exit_code: typeof code === 'number' ? code : null,
        signal: signal || null,
        stdout: Buffer.concat(out.stdout).toString('utf-8'),
        stderr: Buffer.concat(out.stderr).toString('utf-8'),
        truncated: total.stdout > maxBytes || total.stderr > maxBytes,
        stdout_bytes: total.stdout,
        stderr_bytes: total.stderr,
        timed_out: timedOut,
      });
    });
  });
}

/**
 * An interactive login shell on a pty. Returns { pty, unit }.
 * node-pty is required lazily (Android has none; N-API, so plain Node works).
 */
async function spawnLocalShell({ cols = 120, rows = 40, cwd } = {}) {
  const pty = require('node-pty');
  const shell = loginShell();
  const dir = resolveLocalPath(cwd);
  const termEnv = { TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  const decision = IS_WIN ? { mode: 'direct' } : await ptyEscape.launchDecision();
  let file; let args; let env; let unit = null;
  if (IS_WIN) {
    file = shell; args = []; env = cleanEnv();
  } else if (decision.mode === 'systemd-run') {
    unit = unitFor();
    file = decision.systemdRun;
    args = ptyEscape.buildSystemdRunArgs({ unit, shell, shellArgs: ['-l'], setenv: ptyEscape.filterEnv(process.env, termEnv) });
    env = cleanEnv(termEnv);
  } else {
    file = shell; args = ['-l']; env = cleanEnv(termEnv);
  }
  const p = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd: dir, env });
  return { pty: p, unit };
}

module.exports = { runLocal, spawnLocalShell, resolveLocalPath, loginShell, stopUnit, UNIT_PREFIX };
