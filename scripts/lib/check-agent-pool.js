/**
 * Seccion AGP del arnes del main: una conexion SSH por host para la API de
 * agentes (electron/agent/conn-pool.js), contra sshd de OpenSSH reales
 * (scripts/lib/real-sshd.js) con LogLevel INFO: cada login deja una linea
 * "Accepted publickey", y eso es lo que se cuenta.
 *
 *  AGP1 10 run_command seguidos = 1 login
 *  AGP2 read_file / write_file / open_shell sobre la misma conexion
 *  AGP3 12 llamadas a la vez contra MaxSessions 4: todas bien (cola + limite)
 *  AGP4 la cola respeta el timeout de cada llamada
 *  AGP5 cierre por inactividad (plazo acortado) y reconexion
 *  AGP6 editar el host descarta la conexion; lo que corria en la vieja acaba bien
 *  AGP7 matar la conexion en el servidor a mitad de comando: error claro, sin
 *       reintento; la siguiente llamada reconecta
 *  AGP8 lo que estaba en cola cuando cayo se reintenta una vez en la nueva
 *  AGP9 al salir (stop) se cierran todas
 *
 * Solo esta seccion (con AG): TERMILAB_CHECK_ONLY=AG node scripts/check-main.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { startRealSshd } = require('./real-sshd');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* Logins que el sshd ha aceptado hasta ahora (su stderr llega por un pipe: un respiro antes) */
async function logins(sshd) {
  await sleep(150);
  return (sshd.log().match(/Accepted publickey/g) || []).length;
}

/* Los procesos "sshd: ..." de cada conexion (hijos y nietos del sshd del arnes), no los comandos */
function connectionPids(sshd) {
  const rows = execFileSync('ps', ['-e', '-o', 'pid=,ppid=,args='], { encoding: 'utf-8' })
    .split('\n').map(l => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map(m => ({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] }));
  const out = [];
  const walk = (pid) => {
    for (const r of rows.filter(x => x.ppid === pid)) {
      if (/^sshd(-session)?:/.test(r.args)) { out.push(r.pid); walk(r.pid); }
    }
  };
  walk(sshd.pid);
  return out;
}

function killConnections(sshd) {
  const pids = connectionPids(sshd);
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch (_) { /* gone */ } }
  return pids.length;
}

async function seccionAgentPool({ check, ROOT }) {
  const storeService = require(path.join(ROOT, 'electron', 'services', 'store-service.js'));
  const { AgentService } = require(path.join(ROOT, 'electron', 'agent', 'agent-service.js'));
  const { parseKnownHosts } = require(path.join(ROOT, 'electron', 'services', 'known-hosts.js'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlagp-'));
  const files = fs.mkdtempSync(path.join(os.tmpdir(), 'tlagp-files-'));
  const savedAuthSock = process.env.SSH_AUTH_SOCK;
  delete process.env.SSH_AUTH_SOCK;

  let a = null;   // MaxSessions por defecto (10)
  let b = null;   // MaxSessions 4
  const agent = new AgentService();
  agent.userDataDir = dir;
  agent.broadcast = () => {};
  try {
    try {
      a = await startRealSshd({ logLevel: 'INFO' });
      b = await startRealSshd({ logLevel: 'INFO', extra: ['MaxSessions 4'] });
    } catch (err) {
      await check('AGP0 sshd real disponible', () => { throw new Error(`sin sshd: ${err.message}`); });
      return;
    }
    const keyA = await storeService.saveKey({ name: 'AGP key A', privateKey: a.privateKey, type: 'ed25519' });
    const keyA2 = await storeService.saveKey({ name: 'AGP key A (copia)', privateKey: a.privateKey, type: 'ed25519' });
    const keyB = await storeService.saveKey({ name: 'AGP key B', privateKey: b.privateKey, type: 'ed25519' });
    const hostA = await storeService.saveHost({ groupId: null, tags: [], label: 'AGP A', hostname: '127.0.0.1', port: a.port, username: a.user, authType: 'key', keyId: keyA.id });
    await storeService.saveHost({ groupId: null, tags: [], label: 'AGP B', hostname: '127.0.0.1', port: b.port, username: b.user, authType: 'key', keyId: keyB.id });
    for (const s of [a, b]) await storeService.saveKnownHost(parseKnownHosts(`[127.0.0.1]:${s.port} ${s.hostPublicKey}\n`).entries[0]);

    const run = (host, command, extra = {}) => agent.call('run_command', { host, command, ...extra });
    const live = (label) => agent.pool.snapshot().filter(x => x.label === label);

    await check('AGP1 10 run_command seguidos = 1 login en el servidor', async () => {
      for (let i = 0; i < 10; i++) {
        const r = await run('AGP A', `echo n-${i}`);
        assert.strictEqual(r.stdout.trim(), `n-${i}`);
        assert.strictEqual(r.exit_code, 0);
      }
      assert.strictEqual(await logins(a), 1, `logins en el sshd: ${await logins(a)}`);
      assert.strictEqual(live('AGP A').length, 1, JSON.stringify(agent.pool.snapshot()));
    });

    await check('AGP2 read_file, write_file y shell sobre la misma conexion (un canal SFTP reutilizado)', async () => {
      const f = path.join(files, 'p.txt');
      const w = await agent.call('write_file', { host: 'AGP A', path: f, content: 'pool\n', mode: '600' });
      assert.strictEqual(w.bytes_written, 5);
      for (let i = 0; i < 3; i++) assert.strictEqual((await agent.call('read_file', { host: 'AGP A', path: f })).content, 'pool\n');
      assert.ok(live('AGP A')[0].sftp, 'no quedo un canal SFTP abierto para reutilizar');
      const sftp1 = agent.pool.byKey.get(hostA.id).sftp;
      await agent.call('read_file', { host: 'AGP A', path: f });
      assert.strictEqual(agent.pool.byKey.get(hostA.id).sftp, sftp1, 'abrio otro canal SFTP');
      const o = await agent.call('open_shell', { host: 'AGP A' });
      await agent.call('send_input', { session_id: o.session_id, data: 'echo shell-$((5*5))\r' });
      let seen = '';
      for (let i = 0; i < 10 && !seen.includes('shell-25'); i++) seen += (await agent.call('read_output', { session_id: o.session_id, wait_ms: 1500 })).output;
      assert.ok(seen.includes('shell-25'), JSON.stringify(seen.slice(-200)));
      assert.strictEqual((await run('AGP A', 'echo con-shell')).stdout.trim(), 'con-shell');
      await agent.call('close_shell', { session_id: o.session_id });
      assert.strictEqual(await logins(a), 1, 'read/write/shell abrieron otro login');
      assert.strictEqual(live('AGP A').length, 1);
    });

    await check('AGP3 12 llamadas a la vez contra MaxSessions 4: todas bien, limite bajado a 4, 1 login', async () => {
      const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => run('AGP B', `sleep 0.4; echo c-${i}`)));
      rs.forEach((r, i) => assert.strictEqual(r.stdout.trim(), `c-${i}`, JSON.stringify(r)));
      assert.ok(/no more sessions/.test(b.log()), 'el servidor no rechazo ningun canal: la prueba no prueba el limite');
      assert.strictEqual(live('AGP B')[0].limit, 4);
      assert.strictEqual(await logins(b), 1);
    });

    await check('AGP4 la cola respeta el timeout de la llamada', async () => {
      const busy = Array.from({ length: 4 }, () => run('AGP B', 'sleep 2.5'));
      await sleep(300);
      const t0 = Date.now();
      await assert.rejects(run('AGP B', 'echo tarde', { timeout_s: 1 }), (e) => e.code === 'timeout' && /waiting for a free SSH channel/.test(e.message));
      assert.ok(Date.now() - t0 < 2000, `tardo ${Date.now() - t0} ms`);
      for (const r of await Promise.all(busy)) assert.strictEqual(r.exit_code, 0);
    });

    await check('AGP5 sin uso se cierra (plazo acortado) y la siguiente llamada vuelve a entrar', async () => {
      const before = await logins(a);
      agent.pool.idleMs = 400;
      await run('AGP A', 'true');
      await sleep(900);
      assert.strictEqual(live('AGP A').length, 0, 'la conexion sigue abierta');
      assert.strictEqual(connectionPids(a).length, 0, 'el servidor sigue con la conexion');
      agent.pool.idleMs = 10 * 60 * 1000;
      assert.strictEqual((await run('AGP A', 'echo otra')).stdout.trim(), 'otra');
      assert.strictEqual(await logins(a), before + 1);
    });

    await check('AGP6 editar el host descarta la conexion; lo que corria en la vieja termina bien', async () => {
      const before = await logins(a);
      const first = agent.pool.byKey.get(hostA.id).id;
      const slow = run('AGP A', 'sleep 1; echo viejo');
      await sleep(200);
      await storeService.saveHost({ ...(await storeService.getHosts()).find(h => h.id === hostA.id), keyId: keyA2.id });
      assert.strictEqual((await run('AGP A', 'echo nuevo')).stdout.trim(), 'nuevo');
      assert.notStrictEqual(agent.pool.byKey.get(hostA.id).id, first, 'siguio en la conexion vieja');
      assert.strictEqual((await slow).stdout.trim(), 'viejo');
      await sleep(200);
      assert.strictEqual(agent.pool.snapshot().filter(x => x.id === first).length, 0, 'la conexion vieja no se cerro');
      assert.strictEqual(await logins(a), before + 1);
    });

    await check('AGP7 conexion muerta a mitad de comando: error claro, sin reintento; la siguiente reconecta', async () => {
      const marker = path.join(files, 'marker');
      const before = await logins(a);
      const p = run('AGP A', `echo x >> ${marker}; sleep 4`);
      await sleep(700);
      assert.ok(killConnections(a) > 0, 'no encontre la conexion en el servidor');
      await assert.rejects(p, (e) => e.code === 'connection-lost'
        && /Connection to AGP A was lost while the command was running; it may or may not have completed/.test(e.message));
      await sleep(500);
      assert.strictEqual(fs.readFileSync(marker, 'utf-8'), 'x\n', 'el comando se reintento');
      assert.strictEqual((await run('AGP A', 'echo vuelta')).stdout.trim(), 'vuelta');
      assert.strictEqual(await logins(a), before + 1);
    });

    await check('AGP8 lo que estaba en cola al caer se reintenta una vez en la conexion nueva', async () => {
      const before = await logins(b);
      const inFlight = Array.from({ length: 4 }, () => run('AGP B', 'sleep 4').then(() => 'ok', e => e.code));
      await sleep(400);
      const queued = run('AGP B', 'echo en-cola');
      await sleep(200);
      assert.strictEqual(live('AGP B')[0].queued, 1, JSON.stringify(live('AGP B')));
      killConnections(b);
      assert.strictEqual((await queued).stdout.trim(), 'en-cola');
      assert.deepStrictEqual(await Promise.all(inFlight), ['connection-lost', 'connection-lost', 'connection-lost', 'connection-lost']);
      assert.strictEqual(await logins(b), before + 1);
    });

    await check('AGP9 al salir se cierran todas las conexiones', async () => {
      await run('AGP A', 'true');
      await run('AGP B', 'true');
      assert.ok(connectionPids(a).length && connectionPids(b).length);
      await agent.stop();
      await sleep(400);
      assert.deepStrictEqual(agent.pool.snapshot(), []);
      assert.deepStrictEqual([connectionPids(a).length, connectionPids(b).length], [0, 0]);
    });
  } finally {
    try { await agent.stop(); } catch (_) { /* ya parado */ }
    if (a) await a.stop();
    if (b) await b.stop();
    if (savedAuthSock !== undefined) process.env.SSH_AUTH_SOCK = savedAuthSock;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(files, { recursive: true, force: true });
  }
}

module.exports = { seccionAgentPool };
