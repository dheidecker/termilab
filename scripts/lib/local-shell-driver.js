/**
 * Run by scripts/lib/check-local-shell.js under Electron-as-node
 * (ELECTRON_RUN_AS_NODE=1): node-pty is built for Electron's ABI, so plain node
 * can't load it. Drives the REAL local-shell-service through the systemd-run
 * path and prints one JSON line with what it saw. Not part of the app.
 *
 *   argv[2] = repo root
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const Module = require('module');
const { execFileSync } = require('child_process');

const ROOT = process.argv[2];
const svc = (f) => path.join(ROOT, 'electron', 'services', f);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termilab-pty-'));

// The service's only Electron-bound dependencies: the connection log (store ->
// app.getPath) and the window registry. Neither matters here.
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => tmp } };
  if (request === './connection-log-service') return { start: () => 'log', end: () => {} };
  return realLoad.call(this, request, parent, isMain);
};

const escape = require(svc('local-shell-escape.js'));
const service = require(svc('local-shell-service.js'));

const out = { realDecision: null, steps: {} };
const data = new Map();     // sessionId -> accumulated output
const closes = new Map();   // sessionId -> exitCode
service.setMainWindow({
  isDestroyed: () => false,
  webContents: {
    send: (channel, sid, payload) => {
      if (channel === 'local:data') data.set(sid, (data.get(sid) || '') + payload);
      if (channel === 'local:close') closes.set(sid, payload);
    },
  },
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const clean = (s) => (s || '').replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\r/g, '');
async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(50); }
  return null;
}
/* The login shell is up: some output (the prompt), then 500 ms of quiet.
   Typing before that races the profile scripts. */
async function ready(sid) {
  let last = -1, since = Date.now();
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const len = (data.get(sid) || '').length;
    if (len !== last) { last = len; since = Date.now(); } else if (len > 0 && Date.now() - since > 500) return;
    await sleep(50);
  }
}
/* `echo MA""RK1` prints MARK1 but its own echo doesn't contain it */
async function run(sid, cmd, mark) {
  const from = (data.get(sid) || '').length;
  service.write(sid, `${cmd}; echo ${mark.slice(0, 2)}""${mark.slice(2)}\r`);
  const got = await waitFor(() => {
    const txt = clean((data.get(sid) || '').slice(from));
    return new RegExp(`(^|\\n)${mark}\\n`).test(txt) ? txt : null;
  }, 20000);
  if (!got) throw new Error(`no ${mark} in: ${JSON.stringify(clean((data.get(sid) || '').slice(from)).slice(-300))}`);
  return got;
}
const units = (pattern) => {
  try {
    return execFileSync('systemctl', ['--user', 'list-units', '--all', '--plain', '--no-legend', pattern]).toString()
      .split('\n').map(l => l.trim().split(/\s+/)[0]).filter(Boolean);
  } catch (_) { return ['<systemctl failed>']; }
};

(async () => {
  out.realDecision = await escape.launchDecision();
  out.runBefore = units('run-*.service');
  // Force the path under test even if this harness runs with NNP=0.
  const systemdRun = execFileSync('sh', ['-c', 'command -v systemd-run']).toString().trim();
  escape.launchDecision = async () => ({ mode: 'systemd-run', reason: 'forced by the harness', systemdRun });
  // What must not cross into the shell
  process.env.GOOGLE_API_KEY = 'no-debe-cruzar';
  process.env.CHROME_DESKTOP = 'termilab.desktop';
  process.env.GITHUB_TOKEN = 'tampoco-esto';

  const a = await service.spawn({ shell: '/bin/bash', cols: 80, rows: 24, cwd: tmp });
  await ready(a);
  out.steps.unitWhileRunning = units(`${escape.unitName(a)}*`);
  let t = await run(a, 'grep NoNewPrivs /proc/self/status; pwd; stty size', 'MARK1');
  out.steps.nnp = (t.match(/NoNewPrivs:\s*(\d)/) || [])[1];
  out.steps.cwdOk = t.includes(`\n${tmp}\n`) || t.includes(`\n${fs.realpathSync(tmp)}\n`);
  out.steps.sizeBefore = (t.match(/\n(\d+ \d+)\n/) || [])[1];
  service.resize(a, 132, 40);
  await sleep(300);
  t = await run(a, 'stty size', 'MARK2');
  out.steps.sizeAfter = (t.match(/\n(\d+ \d+)\n/) || [])[1];
  service.write(a, 'sleep 30\r');
  await sleep(400);
  service.write(a, '\x03');
  t = await run(a, 'echo rc=$?', 'MARK3');
  out.steps.ctrlC = (t.match(/rc=(\d+)/) || [])[1];
  t = await run(a, 'echo "leak=$(env | grep -c -E \'^(ELECTRON_|CHROME_|GOOGLE_|GITHUB_TOKEN)\')"; echo "term=$TERM"; echo "ct=$COLORTERM"', 'MARK4');
  out.steps.leak = (t.match(/leak=(\d+)/) || [])[1];
  out.steps.term = (t.match(/\nterm=(\S*)\n/) || [])[1];
  out.steps.colorterm = (t.match(/\nct=(\S*)\n/) || [])[1];
  service.write(a, 'exit 7\r');
  out.steps.exitCode = await waitFor(() => closes.has(a) && String(closes.get(a)), 10000);
  await sleep(500);
  out.steps.unitAfterExit = units(`${escape.unitName(a)}*`);

  const b = await service.spawn({ shell: '/bin/bash', cols: 80, rows: 24, cwd: tmp });
  await ready(b);
  await run(b, 'true', 'MARK5');
  await service.kill(b);
  out.steps.killClosed = !!(await waitFor(() => closes.has(b), 5000));
  await sleep(1000);
  out.steps.unitAfterKill = units(`${escape.unitName(b)}*`);
  out.steps.leftover = units(`${escape.UNIT_PREFIX}*`);
  out.runAfter = units('run-*.service');
})()
  .catch((err) => { out.error = err.message; })
  .finally(() => {
    process.stdout.write(`${JSON.stringify(out)}\n`);
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(0);
  });
