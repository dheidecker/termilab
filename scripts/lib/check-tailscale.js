/**
 * Seccion TS del arnes del main (scripts/check-main.js): acceso remoto por
 * Tailscale (electron/web/tailscale.js, remote-access.js, serve-guard.js).
 * NUNCA corre el tailscale de verdad: TERMILAB_TAILSCALE_BIN apunta a un
 * tailscale falso en un mkdtemp que contesta JSON fijo segun FAKE_TS_CASE y
 * anota cada invocacion (argv + pid) en FAKE_TS_LOG.
 *
 *  TS1  ubicacion del binario por sistema (+ la variable de entorno).
 *  TS2  no instalado → reason not-installed.
 *  TS3  parado (Stopped y daemon caido) → stopped.
 *  TS4  sin sesion → logged-out.
 *  TS5  con tags → tagged.
 *  TS6  HTTPS desactivado → https-disabled.
 *  TS7  listo: login y dnsName (sin punto final) correctos.
 *  TS8  Funnel ya activo en el puerto → funnel-on, no se lanza serve.
 *  TS9  puerto ocupado por otro → port-busy, no se lanza serve.
 *  TS10 operator denegado → operator-required con el comando sudo.
 *  TS11 enable lanza serve en primer plano (sin --bg); disable mata al hijo,
 *       corre `serve --https=<port> off` y nunca `reset`.
 *  TS12 si Termilab muere (kill -9), serve-guard mata a serve.
 *  TS13 el hijo cae: se reintenta con backoff y el error queda visible.
 *  TS14 arranque: enabled + Tailscale ya no esta → enabled:false, nada lanzado.
 *  TS15 saveSettings no toca remoteAccess; set-name valida; socket dir 0700.
 *  TS16 canales web:* registrados y por el sobre de wrapHandler.
 *  TS17 el servidor web (syncServer) sigue a enable / resume / disable.
 *
 * Solo esta seccion: TERMILAB_CHECK_ONLY=TS.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const FAKE = String.raw`
const fs = require('fs');
const args = process.argv.slice(2);
const c = process.env.FAKE_TS_CASE || 'ready';
fs.appendFileSync(process.env.FAKE_TS_LOG, JSON.stringify({ args, pid: process.pid, c }) + '\n');
const DNS = 'pc-derek.tail1234.ts.net';
const ready = {
  BackendState: 'Running',
  Self: { UserID: 42, DNSName: DNS + '.', Tags: null },
  User: { '42': { ID: 42, LoginName: 'derek@example.com' } },
  CertDomains: [DNS],
};
const out = (o) => process.stdout.write(JSON.stringify(o));
if (args[0] === 'status') {
  if (c === 'down') { process.stderr.write('failed to connect to local tailscaled; it does not appear to be running\n'); process.exit(1); }
  if (c === 'stopped') { out({ BackendState: 'Stopped', Self: {}, User: {} }); process.exit(1); }
  if (c === 'logged-out') { out({ BackendState: 'NeedsLogin', Self: {}, User: {} }); process.exit(0); }
  if (c === 'tagged') { out({ ...ready, Self: { ...ready.Self, Tags: ['tag:server'] } }); process.exit(0); }
  if (c === 'nohttps') { out({ ...ready, CertDomains: null }); process.exit(0); }
  out(ready); process.exit(0);
}
if (args[0] === 'serve' && args[1] === 'status') {
  if (c === 'funnel') out({ TCP: { '7443': { HTTPS: true } }, Web: { [DNS + ':7443']: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } }, AllowFunnel: { [DNS + ':7443']: true } });
  else if (c === 'busy') out({ TCP: { '7443': { HTTPS: true } }, Web: { [DNS + ':7443']: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } });
  else out({});
  process.exit(0);
}
if (args[0] === 'serve' && args.includes('off')) process.exit(0);
if (args[0] === 'serve') {
  if (c === 'operator') { process.stderr.write('Access denied: serve config denied\nUse sudo tailscale serve ...\n'); process.exit(1); }
  process.stdout.write('Available within your tailnet:\n\nhttps://' + DNS + ':7443/\n\nPress Ctrl+C to exit.\n');
  if (c === 'crash') {
    const n = process.env.FAKE_TS_COUNT;
    const k = Number(fs.existsSync(n) ? fs.readFileSync(n, 'utf-8') : 0) + 1;
    fs.writeFileSync(n, String(k));
    if (k === 1) setTimeout(() => { process.stderr.write('serve: backend went away\n'); process.exit(1); }, 300);
  }
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1000);
} else {
  process.exit(0);
}
`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(50); }
  return false;
}

async function seccionTailscale({ check, ROOT, handlers }) {
  const ts = require(path.join(ROOT, 'electron', 'web', 'tailscale.js'));
  const remote = require(path.join(ROOT, 'electron', 'web', 'remote-access.js'));
  const storeService = require(path.join(ROOT, 'electron', 'services', 'store-service.js'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termilab-ts-'));
  const fakeJs = path.join(dir, 'fake-tailscale.js');
  const bin = path.join(dir, 'tailscale');
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(fakeJs, FAKE);
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${fakeJs}" "$@"\n`, { mode: 0o755 });
  const userData = path.join(dir, 'userData');
  fs.mkdirSync(userData);

  const saved = { bin: process.env.TERMILAB_TAILSCALE_BIN, c: process.env.FAKE_TS_CASE, log: process.env.FAKE_TS_LOG };
  process.env.TERMILAB_TAILSCALE_BIN = bin;
  process.env.FAKE_TS_LOG = log;
  process.env.FAKE_TS_COUNT = path.join(dir, 'count');
  const useCase = (c) => { process.env.FAKE_TS_CASE = c; fs.writeFileSync(log, ''); };
  const calls = () => fs.readFileSync(log, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const serveRuns = () => calls().filter(x => x.args[0] === 'serve' && x.args[1] !== 'status' && !x.args.includes('off'));
  const allCalls = [];
  const keep = () => { allCalls.push(...calls()); };
  remote.configure({ userData, backoffMs: [150] });

  await check('TS1 ubicacion del binario: PATH en Linux, rutas de Mac/Windows, variable de entorno', () => {
    const none = () => false;
    assert.strictEqual(ts.resolveBinary({ platform: 'linux', env: {}, exists: none }), 'tailscale');
    assert.strictEqual(ts.resolveBinary({ platform: 'darwin', env: {}, exists: p => p.startsWith('/Applications') }),
      '/Applications/Tailscale.app/Contents/MacOS/Tailscale');
    assert.strictEqual(ts.resolveBinary({ platform: 'darwin', env: {}, exists: p => p === '/usr/local/bin/tailscale' }), '/usr/local/bin/tailscale');
    assert.strictEqual(ts.resolveBinary({ platform: 'darwin', env: {}, exists: none }), 'tailscale');
    assert.strictEqual(ts.resolveBinary({ platform: 'win32', env: { ProgramFiles: 'D:\\PF' }, exists: () => true }), 'D:\\PF\\Tailscale\\tailscale.exe');
    assert.strictEqual(ts.resolveBinary({ platform: 'win32', env: {}, exists: none }), 'tailscale.exe');
    assert.strictEqual(ts.resolveBinary({ platform: 'darwin', env: { TERMILAB_TAILSCALE_BIN: '/x/ts' }, exists: () => true }), '/x/ts');
    assert.strictEqual(ts.DEFAULT_PORT, 7443);
  });

  await check('TS2 no instalado → not-installed', async () => {
    process.env.TERMILAB_TAILSCALE_BIN = path.join(dir, 'no-existe');
    try {
      const s = await ts.status();
      assert.strictEqual(s.installed, false);
      assert.strictEqual(s.reason, 'not-installed');
      await assert.rejects(ts.enable({ port: 7443, target: 'unix:/tmp/x.sock' }), e => e.code === 'not-installed');
    } finally { process.env.TERMILAB_TAILSCALE_BIN = bin; }
  });

  await check('TS3 parado (Stopped y daemon caido) → stopped', async () => {
    useCase('stopped');
    let s = await ts.status();
    assert.deepStrictEqual([s.installed, s.running, s.reason], [true, false, 'stopped']);
    useCase('down');
    s = await ts.status();
    assert.deepStrictEqual([s.installed, s.running, s.reason], [true, false, 'stopped']);
    keep();
  });

  await check('TS4 sin sesion → logged-out', async () => {
    useCase('logged-out');
    const s = await ts.status();
    assert.strictEqual(s.reason, 'logged-out');
    keep();
  });

  await check('TS5 con tags → tagged (y enable lo rechaza)', async () => {
    useCase('tagged');
    const s = await ts.status();
    assert.deepStrictEqual([s.tagged, s.reason], [true, 'tagged']);
    await assert.rejects(ts.enable({ port: 7443, target: 'unix:/tmp/x.sock' }), e => e.code === 'tagged');
    assert.strictEqual(serveRuns().length, 0, 'lanzo serve con un equipo con tags');
    keep();
  });

  await check('TS6 HTTPS desactivado → https-disabled', async () => {
    useCase('nohttps');
    const s = await ts.status();
    assert.deepStrictEqual([s.httpsEnabled, s.reason], [false, 'https-disabled']);
    keep();
  });

  await check('TS7 listo: login y dnsName correctos', async () => {
    useCase('ready');
    const s = await ts.status();
    assert.deepStrictEqual(s, {
      installed: true, running: true, login: 'derek@example.com', dnsName: 'pc-derek.tail1234.ts.net',
      httpsEnabled: true, tagged: false, reason: null,
    });
    keep();
  });

  await check('TS8 Funnel activo en el puerto → funnel-on, sin lanzar serve', async () => {
    useCase('funnel');
    await assert.rejects(ts.enable({ port: 7443, target: 'unix:/tmp/x.sock' }), e => e.code === 'funnel-on');
    assert.strictEqual(serveRuns().length, 0);
    const st = await remote.enable();
    assert.strictEqual(st.error && st.error.code, 'funnel-on');
    assert.strictEqual(st.remoteAccess.enabled, false, 'quedo activado con Funnel encendido');
    keep();
  });

  await check('TS9 puerto ocupado por otro → port-busy, sin lanzar serve', async () => {
    useCase('busy');
    await assert.rejects(ts.enable({ port: 7443, target: 'unix:/tmp/x.sock' }), e => e.code === 'port-busy');
    assert.strictEqual(serveRuns().length, 0);
    // y disable no apaga lo ajeno
    const r = await ts.disable({ port: 7443, target: 'unix:/tmp/x.sock' });
    assert.strictEqual(r.removed, false);
    assert.ok(!calls().some(x => x.args.includes('off')), 'disable apago un puerto ajeno');
    keep();
  });

  await check('TS10 operator denegado → operator-required con el comando', async () => {
    useCase('operator');
    await assert.rejects(ts.enable({ port: 7443, target: 'unix:/tmp/x.sock' }),
      e => e.code === 'operator-required' && e.command === 'sudo tailscale set --operator=$USER' && e.message.includes(e.command));
    const st = await remote.enable();
    assert.strictEqual(st.error.code, 'operator-required');
    assert.strictEqual(st.error.command, 'sudo tailscale set --operator=$USER');
    assert.strictEqual(st.remoteAccess.enabled, false);
    keep();
  });

  await check('TS11 enable en primer plano (sin --bg); disable mata al hijo, off y nunca reset', async () => {
    useCase('ready');
    const st = await remote.enable();
    assert.strictEqual(st.error, null, st.error && st.error.message);
    assert.deepStrictEqual([st.remoteAccess.enabled, st.serving, st.url], [true, true, 'https://pc-derek.tail1234.ts.net:7443/']);
    const runs = serveRuns();
    assert.strictEqual(runs.length, 1);
    const sock = path.join(userData, 'web', 'termilab.sock');
    assert.deepStrictEqual(runs[0].args, ['serve', '--https=7443', `unix:${sock}`]);
    assert.ok(alive(runs[0].pid), 'serve no esta vivo');
    const off = await remote.disable();
    assert.deepStrictEqual([off.remoteAccess.enabled, off.serving, off.url], [false, false, null]);
    assert.ok(await waitFor(() => !alive(runs[0].pid)), 'disable no mato al hijo');
    assert.ok(calls().some(x => x.args.join(' ') === 'serve --https=7443 off'), 'disable no corrio serve off');
    keep();
  });

  await check('TS12 Termilab muere (kill -9) → serve-guard mata a serve', async () => {
    useCase('ready');
    const script = `require(${JSON.stringify(path.join(ROOT, 'electron', 'web', 'tailscale.js'))})
      .enable({ port: 7443, target: 'unix:/tmp/x.sock' }).then(() => console.log('UP'), e => { console.log('ERR', e.code); process.exit(1); });`;
    const p = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'], env: process.env });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    assert.ok(await waitFor(() => out.includes('UP') || out.includes('ERR')), 'el enable de prueba no termino');
    assert.ok(out.includes('UP'), out);
    const runs = serveRuns();
    assert.strictEqual(runs.length, 1);
    assert.ok(alive(runs[0].pid));
    p.kill('SIGKILL');
    assert.ok(await waitFor(() => !alive(runs[0].pid)), 'serve sobrevivio a Termilab');
    keep();
  });

  await check('TS13 el hijo cae: reintento con backoff y error visible', async () => {
    remote.configure({ backoffMs: [700] });
    useCase('crash');
    try { fs.unlinkSync(process.env.FAKE_TS_COUNT); } catch (_) { /* no habia */ }
    const st = await remote.enable();
    assert.strictEqual(st.serving, true, st.error && st.error.message);
    assert.ok(await waitFor(async () => (await remote.status()).error !== null, 3000), 'la caida no dejo error visible');
    const caido = await remote.status();
    assert.strictEqual(caido.error.code, 'serve-exited');
    assert.ok(caido.error.message.includes('backend went away'), caido.error.message);
    assert.ok(await waitFor(() => serveRuns().length === 2 && remote.handle, 5000), 'no reintento');
    assert.strictEqual((await remote.status()).error, null, 'el reintento bueno no limpio el error');
    await remote.disable();
    assert.ok(await waitFor(() => serveRuns().every(r => !alive(r.pid))), 'quedo un serve vivo');
    keep();
  });

  await check('TS14 arranque: enabled y Tailscale ya no esta → se desactiva sin lanzar nada', async () => {
    await storeService.saveRemoteAccess({ enabled: true });
    process.env.TERMILAB_TAILSCALE_BIN = path.join(dir, 'no-existe');
    try {
      useCase('ready');
      const st = await remote.resume();
      assert.strictEqual(st.remoteAccess.enabled, false);
      assert.strictEqual(st.serving, false);
      assert.strictEqual(st.error.code, 'not-installed');
      assert.strictEqual(calls().length, 0);
    } finally { process.env.TERMILAB_TAILSCALE_BIN = bin; }
    // y con Tailscale listo, se reaplica
    await storeService.saveRemoteAccess({ enabled: true });
    useCase('ready');
    const st = await remote.resume();
    assert.deepStrictEqual([st.remoteAccess.enabled, st.serving], [true, true]);
    await remote.disable();
    keep();
  });

  await check('TS15 saveSettings no toca remoteAccess; set-name valida; socket dir 0700', async () => {
    await storeService.saveRemoteAccess({ enabled: true, hostName: 'Oficina' });
    await storeService.saveSettings({ remoteAccess: { enabled: false, hostName: 'otro' }, ai: { key: 'x' } });
    let s = await storeService.getSettings();
    assert.deepStrictEqual([s.remoteAccess.enabled, s.remoteAccess.hostName, s.remoteAccess.port], [true, 'Oficina', 7443]);
    assert.ok(!('ai' in s));
    await storeService.saveRemoteAccess({ enabled: false });
    useCase('ready');
    const st = await remote.setName('  PC del taller  ');
    assert.strictEqual(st.remoteAccess.hostName, 'PC del taller');
    await assert.rejects(remote.setName('   '));
    await assert.rejects(remote.setName('x'.repeat(64)));
    s = await storeService.getSettings();
    assert.strictEqual(s.remoteAccess.hostName, 'PC del taller');
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(path.join(userData, 'web')).mode & 0o777, 0o700);
    }
    keep();
  });

  await check('TS16 canales web:* registrados y por el sobre de wrapHandler', async () => {
    for (const c of ['web:status', 'web:enable', 'web:disable', 'web:set-name']) assert.ok(handlers.has(c), `falta ${c}`);
    useCase('ready');
    const r = await handlers.get('web:status')({}, undefined);
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.data.tailscale.login, 'derek@example.com');
    const bad = await handlers.get('web:set-name')({}, '');
    assert.strictEqual(bad.success, false);
    keep();
  });

  await check('TS17 el servidor web sigue al interruptor: enable/resume lo arrancan con login, dnsName y puerto; disable lo para', async () => {
    const llamadas = [];
    const antes = remote.syncServer;
    remote.configure({ syncServer: async (id) => { llamadas.push(id ? { login: id.getAllowedLogin(), dns: id.getDnsName(), port: id.getPort() } : null); } });
    try {
      useCase('ready');
      let st = await remote.enable();
      assert.strictEqual(st.error, null, st.error && st.error.message);
      assert.deepStrictEqual(llamadas, [{ login: 'derek@example.com', dns: 'pc-derek.tail1234.ts.net', port: 7443 }]);
      await remote.disable();
      assert.deepStrictEqual(llamadas[1], null, 'disable no paro el servidor');
      await storeService.saveRemoteAccess({ enabled: true });
      st = await remote.resume();
      assert.strictEqual(st.serving, true);
      assert.deepStrictEqual(llamadas[2], { login: 'derek@example.com', dns: 'pc-derek.tail1234.ts.net', port: 7443 }, 'resume no arranco el servidor');
      await remote.disable();
      /* Un servidor que no arranca: error visible, no excepcion */
      remote.configure({ syncServer: async (id) => { if (id) throw new Error('socket ocupado'); } });
      st = await remote.enable();
      assert.strictEqual(st.error && st.error.code, 'server-failed');
      await remote.disable();
    } finally {
      remote.syncServer = antes;
    }
    keep();
  });

  await check('TS* ninguna invocacion uso --bg ni serve reset', () => {
    keep();
    assert.ok(allCalls.length > 0, 'no se capturo nada: la prueba no prueba');
    assert.ok(!allCalls.some(x => x.args.includes('reset')), 'alguien corrio serve reset');
    assert.ok(!allCalls.some(x => x.args.includes('--bg')), 'alguien uso --bg');
  });

  await remote.stop();
  for (const [k, v] of [['TERMILAB_TAILSCALE_BIN', saved.bin], ['FAKE_TS_CASE', saved.c], ['FAKE_TS_LOG', saved.log]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  delete process.env.FAKE_TS_COUNT;
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = { seccionTailscale };
