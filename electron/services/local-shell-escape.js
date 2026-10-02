/**
 * Linux only: start local shells OUTSIDE Termilab's process tree when Termilab
 * runs with `no_new_privs` set.
 *
 * Why: `app.relaunch()` (what electron-updater's quitAndInstall calls after
 * `dpkg -i` / `pacman -U`) goes through Chromium's relauncher, which is
 * started with base::LaunchProcess — and that sets PR_SET_NO_NEW_PRIVS on its
 * child unless told otherwise. The relaunched Termilab inherits NNP=1, every
 * shell node-pty spawns inherits it too, and it can never be cleared. With NNP
 * the kernel ignores file capabilities and setuid bits, so snap-confine
 * ("required permitted capability cap_dac_override not found"), sudo, pkexec,
 * ping… all fail. A Termilab started from the dock has NNP=0 and is fine.
 *
 * The way out is to have the user's systemd manager (always NNP=0) start the
 * shell as a transient unit: `systemd-run --user --pty --wait …`. systemd-run
 * forwards a pty of its own (ptyfwd): bytes in/out, SIGWINCH from node-pty's
 * resize, and its exit status is the shell's. When systemd-run dies (tab
 * closed) its master side closes, the shell gets SIGHUP and the unit ends.
 *
 * Everything here except the probes is a pure function, so the harness
 * (scripts/lib/check-local-shell.js) can test decisions without a systemd.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const UNIT_PREFIX = 'termilab-shell-';

/* What the shell gets from Termilab. The base environment of a systemd-run
   unit is the user manager's (the same one gnome-terminal-server gets); these
   override it with what Termilab itself sees. Nothing else crosses: no
   ELECTRON_*, CHROME_*, GOOGLE_*, NODE_OPTIONS, no tokens that happen to be in
   Termilab's environment. */
const PASS_EXACT = new Set([
  'COLORTERM', 'LANG', 'LANGUAGE', 'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL',
  'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
  'SSH_AUTH_SOCK', 'XAUTHORITY', 'TERM',
]);
const isPassed = (name) => PASS_EXACT.has(name) || name.startsWith('LC_');

/* A name systemd accepts in --setenv, and a value that survives being one argv
   entry (systemd rejects control characters other than tab). */
const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// eslint-disable-next-line no-control-regex
const VALID_VALUE = /^[^\x00-\x08\x0a-\x1f\x7f]*$/;

/**
 * The environment handed to the shell through --setenv.
 * @param {object} base   Termilab's process.env
 * @param {object} extra  what local-shell-service sets itself (options.env, TERM…);
 *                        always passed, it is ours
 */
function filterEnv(base, extra = {}) {
  const out = {};
  for (const [k, v] of Object.entries(base || {})) {
    if (typeof v !== 'string' || !isPassed(k)) continue;
    out[k] = v;
  }
  for (const [k, v] of Object.entries(extra || {})) {
    if (v === undefined || v === null) continue;
    out[k] = String(v);
  }
  for (const [k, v] of Object.entries(out)) {
    if (!VALID_NAME.test(k) || !VALID_VALUE.test(v)) delete out[k];
  }
  return out;
}

/** "NoNewPrivs:\t1" in a /proc/<pid>/status text -> true; absent -> false */
function parseNoNewPrivs(statusText) {
  const m = /^NoNewPrivs:\s*(\d+)/m.exec(statusText || '');
  return !!m && m[1] !== '0';
}

/**
 * Direct spawn or systemd-run? Pure: every fact is passed in.
 * @returns {{ mode: 'direct'|'systemd-run', reason: string }}
 */
function decideLaunch({ platform, env = {}, noNewPrivs, systemdRun, managerReachable }) {
  if (platform !== 'linux') return { mode: 'direct', reason: 'not linux' };
  if (env.TERMILAB_DIRECT_PTY === '1') return { mode: 'direct', reason: 'TERMILAB_DIRECT_PTY=1' };
  if (!noNewPrivs) return { mode: 'direct', reason: 'no_new_privs is 0' };
  if (!systemdRun) return { mode: 'direct', reason: 'systemd-run not found' };
  if (!env.DBUS_SESSION_BUS_ADDRESS && !env.XDG_RUNTIME_DIR) return { mode: 'direct', reason: 'no session bus' };
  if (!managerReachable) return { mode: 'direct', reason: 'user manager not reachable' };
  return { mode: 'systemd-run', reason: 'no_new_privs is 1' };
}

/**
 * argv for node-pty: `systemd-run <args>`. node-pty's cwd is the shell's cwd
 * (--same-dir), exactly as with the direct spawn.
 */
function buildSystemdRunArgs({ unit, shell, shellArgs = [], setenv = {} }) {
  const args = ['--user', '--pty', '--quiet', '--collect', '--wait', '--same-dir', `--unit=${unit}`];
  for (const [k, v] of Object.entries(setenv)) args.push(`--setenv=${k}=${v}`);
  args.push('--', shell, ...shellArgs);
  return args;
}

const unitName = (sessionId) => `${UNIT_PREFIX}${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '')}`;

// ─── Probes (impure, cached) ───────────────────────────────

function findInPath(cmd, PATH = process.env.PATH || '') {
  for (const dir of PATH.split(':')) {
    if (!dir) continue;
    const full = path.join(dir, cmd);
    try { fs.accessSync(full, fs.constants.X_OK); return full; } catch (_) { /* next */ }
  }
  return null;
}

function readSelfNoNewPrivs() {
  try { return parseNoNewPrivs(fs.readFileSync('/proc/self/status', 'utf-8')); } catch (_) { return false; }
}

/* `is-system-running` exits non-zero for "degraded" too, which is a reachable
   manager: decide on what it prints, not on its exit code. */
function probeManager(env) {
  return new Promise((resolve) => {
    execFile('systemctl', ['--user', 'is-system-running'], { env, timeout: 2000 }, (_err, stdout) => {
      const state = String(stdout || '').trim();
      resolve(['running', 'degraded', 'starting', 'initializing'].includes(state));
    });
  });
}

let cached = null;
/** The decision for this process, computed once (NNP can't change, neither does the manager). */
function launchDecision() {
  if (!cached) {
    cached = (async () => {
      const facts = {
        platform: process.platform,
        env: process.env,
        noNewPrivs: process.platform === 'linux' && readSelfNoNewPrivs(),
        systemdRun: null,
        managerReachable: false,
      };
      const quick = decideLaunch({ ...facts, systemdRun: 'x', managerReachable: true });
      if (quick.mode === 'direct') return quick;
      facts.systemdRun = findInPath('systemd-run');
      if (facts.systemdRun) facts.managerReachable = await probeManager(process.env);
      const d = decideLaunch(facts);
      return { ...d, systemdRun: facts.systemdRun };
    })();
    cached.then((d) => console.log(`[LocalShellService] local shells: ${d.mode} (${d.reason})`));
  }
  return cached;
}

/** Tab closed: make sure the unit is gone (normally it already is). Never throws. */
function stopUnit(unit) {
  try {
    execFile('systemctl', ['--user', 'stop', '--no-block', `${unit}.service`], { timeout: 3000 }, () => {});
  } catch (_) { /* best effort */ }
}

module.exports = {
  UNIT_PREFIX,
  filterEnv,
  parseNoNewPrivs,
  decideLaunch,
  buildSystemdRunArgs,
  unitName,
  launchDecision,
  stopUnit,
  findInPath,
  probeManager,
  _resetCache: () => { cached = null; },
};
