/**
 * Run by scripts/lib/check-local-keeper.js under Electron-as-node
 * (ELECTRON_RUN_AS_NODE=1: node-pty is built for Electron's ABI). Drives the
 * REAL local-shell-service + local-keeper with $HOME pointing at a temp dir.
 * Not part of the app.
 *
 *   argv[2] = repo root, argv[3] = phase:
 *     'main'     every in-process check; leaves ONE kept session alive (its
 *                key/id/pid in the JSON line) and then waits forever: the
 *                harness kills this whole process tree (it runs it inside a
 *                transient unit and stops the unit, like an app.slice
 *                run-*.service that dies with Termilab).
 *     'reattach' argv[4] = sessionKey, argv[5] = marker: attach that key again,
 *                report the shell pid and whether the marker was replayed,
 *                then End the session.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const Module = require('module');
const { execFileSync } = require('child_process');

const ROOT = process.argv[2];
const PHASE = process.argv[3] || 'main';
const svc = (f) => path.join(ROOT, 'electron', 'services', f);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlk-cwd-'));

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => tmp } };
  if (request === './connection-log-service') return { start: () => 'log', end: () => {} };
  return realLoad.call(this, request, parent, isMain);
};

const keeper = require(svc('keeper-service.js'));
const localKeeper = require(svc('local-keeper.js'));
const escape = require(svc('local-shell-escape.js'));
const service = require(svc('local-shell-service.js'));
localKeeper.keepOverride = true;

const out = { phase: PHASE, steps: {} };
const data = new Map();
const closes = new Map();
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
const clean = (s) => (s || '').replace(/\x1b\[[0-9;?>=]*[a-zA-Z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[c=>78]/g, '').replace(/\r/g, '');
async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(50); }
  return null;
}
async function ready(sid) {
  let last = -1, since = Date.now();
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const len = (data.get(sid) || '').length;
    if (len !== last) { last = len; since = Date.now(); } else if (len > 0 && Date.now() - since > 700) return;
    await sleep(50);
  }
}
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
const pidOf = async (sid, mark) => {
  const t = await run(sid, 'echo "PID=$$"', mark);
  return Number((t.match(/PID=(\d+)/) || [])[1]);
};
const binPath = () => path.join(os.homedir(), '.termilab', 'bin', keeper.localBinaries().binaries[localKeeper.archFor(process.arch)].file);
const list = () => keeper.parseList(execFileSync(binPath(), ['list']).toString());
const key = (n) => `lk-${process.pid}-${n}-${Date.now()}`;

async function main() {
  out.nnpSelf = (fs.readFileSync('/proc/self/status', 'utf-8').match(/NoNewPrivs:\s*(\d)/) || [])[1];
  out.home = os.homedir();
  const prep = await localKeeper.prepare();
  out.steps.prepare = { fallback: !!prep.fallback, reason: prep.reason || null, systemdRun: !!prep.systemdRun, bin: prep.bin || null };
  if (prep.fallback) throw new Error(`prepare: ${prep.reason}`);
  const st = (p) => { const s = fs.lstatSync(p); return { mode: (s.mode & 0o777).toString(8), link: s.isSymbolicLink(), file: s.isFile() }; };
  out.steps.files = {
    dir: st(path.join(os.homedir(), '.termilab')), bin: st(path.join(os.homedir(), '.termilab', 'bin')),
    run: st(path.join(os.homedir(), '.termilab', 'run')), exe: st(prep.bin),
    sha: require('crypto').createHash('sha256').update(fs.readFileSync(prep.bin)).digest('hex'),
    manifestSha: JSON.parse(fs.readFileSync(path.join(ROOT, 'electron', 'keeper', 'manifest.json'), 'utf-8')).binaries[prep.arch].sha256,
    tmpLeft: fs.readdirSync(path.join(os.homedir(), '.termilab', 'bin')).filter(n => n.startsWith('.tmp-')),
  };
  /* What the NNP=1 escape would do for a plain shell: forced, to prove a
     kept tab does not go through a per-tab unit at all */
  const systemdRun = execFileSync('sh', ['-c', 'command -v systemd-run']).toString().trim();
  escape.launchDecision = async () => ({ mode: 'systemd-run', reason: 'forced by the harness', systemdRun });

  // ── A: create, NNP, own unit, no per-tab unit ──
  const K = key('a');
  const id = localKeeper.sessionFor(K).id;
  out.steps.idMatchesRemote = id === keeper.keeperIdFor(K);
  const a = await service.spawn({ shell: '/bin/bash', cols: 80, rows: 24, cwd: tmp, sessionKey: K });
  out.steps.infoA = service.spawnInfo(a);
  await ready(a);
  out.steps.perTabUnit = units(`${escape.unitName(a)}*`);
  out.steps.keepUnit = units(`${localKeeper.keepUnitName(id)}*`);
  let t = await run(a, 'grep NoNewPrivs /proc/self/status; cat /proc/self/cgroup; pwd; echo "KID=$TERMILAB_KEEPER_ID"', 'MARKA');
  out.steps.nnpInside = (t.match(/NoNewPrivs:\s*(\d)/) || [])[1];
  out.steps.cgroupInside = (t.match(/0::(\S+)/) || [])[1];
  out.steps.cwdOk = t.includes(`\n${tmp}\n`) || t.includes(`\n${fs.realpathSync(tmp)}\n`);
  out.steps.kid = (t.match(/\nKID=(\S*)/) || [])[1];
  const pidA = await pidOf(a, 'MARKB');

  // ── close plan: shell / background job / foreground command ──
  out.steps.fgShell = await service.keeperForeground(a);
  service.write(a, 'sleep 600 &\r');
  out.steps.fgJobs = await waitFor(async () => { const f = await service.keeperForeground(a); return f.jobs && f.jobs.includes('sleep') ? f : null; }, 5000);
  await run(a, 'kill %1 2>/dev/null; wait 2>/dev/null; true', 'MARKC');
  service.write(a, 'sleep 600\r');
  out.steps.fgCmd = await waitFor(async () => { const f = await service.keeperForeground(a); return f.fgCommand === 'sleep' ? f : null; }, 5000);
  service.write(a, '\x03');
  await run(a, 'true', 'MARKD');

  // ── seq continuity across a detach (tab closed mid-output) ──
  service.write(a, 'for i in $(seq 1 60); do echo "L$i"; sleep 0.05; done; echo "SE""QDONE"\r');
  await sleep(1200);
  await service.kill(a);                         // tab closed: detach only
  out.steps.closedA = !!(await waitFor(() => closes.has(a), 5000));
  out.steps.afterDetach = list().filter(r => r.id === id).map(r => ({ attached: r.attached, shellPid: r.shellPid }));
  await sleep(3000);                             // the loop finishes with nobody attached
  const b = await service.spawn({ shell: '/bin/bash', cols: 80, rows: 24, cwd: tmp, sessionKey: K });
  out.steps.infoB = service.spawnInfo(b);
  await waitFor(() => clean(data.get(b) || '').includes('SEQDONE'), 8000);
  const replay = clean(data.get(b) || '');
  const nums = [...replay.matchAll(/(?:^|\n)L(\d+)(?=\n)/g)].map(m => Number(m[1]));
  out.steps.seq = { count: nums.length, inOrder: nums.every((n, i) => n === i + 1), done: replay.includes('SEQDONE') };
  out.steps.pidSame = (await pidOf(b, 'MARKE')) === pidA;

  // ── the attach client killed from outside: the tab reattaches by itself ──
  const ptyPid = service.shells.get(b).pid;
  process.kill(ptyPid, 'SIGKILL');
  await sleep(1500);
  out.steps.reattachedPty = service.shells.has(b) && service.shells.get(b).pid !== ptyPid;
  out.steps.pidAfterKill = (await pidOf(b, 'MARKF')) === pidA;
  out.steps.daemonAlive = list().some(r => r.id === id);

  // ── stop a would-be per-tab unit: there is none; stopping the escape
  //    units of this run must not touch the session ──
  try { execFileSync('systemctl', ['--user', 'stop', `${escape.unitName(b)}.service`], { stdio: 'ignore' }); } catch (_) { /* none */ }
  out.steps.aliveAfterUnitStop = list().some(r => r.id === id);

  // ── End = KILL: session and its unit gone ──
  await service.keeperEnd(b);
  await sleep(800);
  out.steps.endGone = !list().some(r => r.id === id);
  out.steps.endUnit = units(`${localKeeper.keepUnitName(id)}*`);
  out.steps.closedB = closes.has(b);

  // ── adopted key of a session that does not exist: 102, never created ──
  const ghost = 'zzzzzzzzzzzzzzzzzzzzzzzzzz';
  const g = await service.spawn({ shell: '/bin/bash', cols: 80, rows: 24, cwd: tmp, sessionKey: `keeper:${ghost}` });
  await waitFor(() => closes.has(g), 5000);
  out.steps.ghost = { code: closes.get(g), created: list().some(r => r.id === ghost), said: /no longer exists/.test(clean(data.get(g) || '')) };

  // ── direct mode (no systemd): the attach creates; same shell on reattach ──
  localKeeper.forceDirect = true;
  localKeeper.clearCache();
  const KD = key('d');
  const d1 = await service.spawn({ shell: '/bin/bash', cols: 80, rows: 24, cwd: tmp, sessionKey: KD });
  await ready(d1);
  const pd = await pidOf(d1, 'MARKG');
  await service.kill(d1);
  await sleep(500);
  const d2 = await service.spawn({ shell: '/bin/bash', cols: 80, rows: 24, cwd: tmp, sessionKey: KD });
  await ready(d2);
  out.steps.direct = { kept: service.spawnInfo(d2).kept, same: (await pidOf(d2, 'MARKH')) === pd, unit: units(`${localKeeper.keepUnitName(localKeeper.sessionFor(KD).id)}*`) };
  await service.keeperEnd(d2);
  localKeeper.forceDirect = false;
  localKeeper.clearCache();

  // ── fallback: no binary for this arch → plain shell + one dim line ──
  const realLocalBinary = keeper.localBinary;
  keeper.localBinary = () => null;
  localKeeper.clearCache();
  const f = await service.spawn({ shell: '/bin/bash', cols: 80, rows: 24, cwd: tmp, sessionKey: key('f') });
  out.steps.fallbackInfo = service.spawnInfo(f);
  await ready(f);
  out.steps.fallbackShell = /(^|\n)FB1\n/.test(await run(f, 'true', 'FB1'));
  await service.kill(f);
  keeper.localBinary = realLocalBinary;
  localKeeper.clearCache();

  // ── off in Settings → plain shell, nothing kept ──
  localKeeper.keepOverride = false;
  const o = await service.spawn({ shell: '/bin/bash', cols: 80, rows: 24, cwd: tmp, sessionKey: key('o') });
  out.steps.offInfo = service.spawnInfo(o);
  await service.kill(o);
  localKeeper.keepOverride = true;

  // ── the survivor: left running for the harness to kill us around it ──
  const KS = key('s');
  const s = await service.spawn({ shell: '/bin/bash', cols: 80, rows: 24, cwd: tmp, sessionKey: KS });
  await ready(s);
  const marker = `SURV${process.pid}`;
  await run(s, `echo ${marker.slice(0, 2)}""${marker.slice(2)}X`, 'MARKS');
  out.survivor = { key: KS, id: localKeeper.sessionFor(KS).id, shellPid: await pidOf(s, 'MARKT'), marker: `${marker}X`, attachPid: service.shells.get(s).pid };
  out.survivor.daemonPid = (list().find(r => r.id === out.survivor.id) || {}).pid;
}

async function reattach() {
  const K = process.argv[4];
  const marker = process.argv[5];
  const s = await service.spawn({ shell: '/bin/bash', cols: 80, rows: 24, cwd: tmp, sessionKey: K });
  out.steps.info = service.spawnInfo(s);
  await waitFor(() => clean(data.get(s) || '').includes(marker), 8000);
  out.steps.replayed = clean(data.get(s) || '').includes(marker);
  out.steps.shellPid = await pidOf(s, 'MARKR');
  const id = localKeeper.sessionFor(K).id;
  await service.keeperEnd(s);
  await sleep(800);
  out.steps.gone = !list().some(r => r.id === id);
  out.steps.unit = units(`${localKeeper.keepUnitName(id)}*`);
}

(PHASE === 'reattach' ? reattach() : main())
  .catch((err) => { out.error = err.stack || err.message; })
  .finally(() => {
    process.stdout.write(`${JSON.stringify(out)}\n`);
    fs.rmSync(tmp, { recursive: true, force: true });
    if (PHASE === 'main' && !out.error) setInterval(() => {}, 60000);   // wait to be killed
    else setTimeout(() => process.exit(0), 100);
  });
