/**
 * Seccion AG del arnes del main (scripts/check-main.js): la API local para
 * agentes de IA (electron/agent/agent-service.js) y su servidor MCP por stdio
 * (electron/agent/mcp.js), de verdad:
 *
 *  - socket unix 0600 en una carpeta 0700, token 0600; token malo = fuera
 *  - MCP por stdio con `node electron/agent/mcp.js` (initialize, discover,
 *    tools/list, tools/call) contra el servicio escuchando en este proceso
 *  - run_command contra un sshd de OpenSSH real (scripts/lib/real-sshd.js)
 *  - host key desconocida / cambiada = rechazo, y known hosts sin tocar
 *  - topes de salida, timeout, shell interactiva (remota y local, pty)
 *  - "local" con no_new_privs: el comando sale del gestor de usuario (NNP 0)
 *  - ningun secreto (contrasena, passphrase, clave privada) en ningun
 *    resultado, log, consola ni push a ventanas
 *
 * Solo esta seccion: TERMILAB_CHECK_ONLY=AG node scripts/check-main.js
 */
const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { startRealSshd } = require('./real-sshd');

const SECRET_PW = 'centinela-contrasena-AG-9f3k';
const SECRET_PP = 'centinela-passphrase-AG-7q2z';

/* Cliente MCP por stdio: una linea JSON por mensaje */
function mcpClient(ROOT, env) {
  const child = spawn(process.execPath, [path.join(ROOT, 'electron', 'agent', 'mcp.js')], {
    env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  const transcript = [];
  const waiting = new Map();
  const stray = [];
  child.stdout.setEncoding('utf-8');
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      transcript.push(line);
      let msg;
      try { msg = JSON.parse(line); } catch (_) { stray.push(line); continue; }
      const w = waiting.get(msg.id);
      if (w) { waiting.delete(msg.id); w(msg); } else stray.push(line);
    }
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  let n = 0;
  const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
  const request = (method, params, timeoutMs = 30000) => new Promise((resolve, reject) => {
    const id = ++n;
    const t = setTimeout(() => { waiting.delete(id); reject(new Error(`MCP ${method}: sin respuesta`)); }, timeoutMs);
    waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
    send({ jsonrpc: '2.0', id, method, params });
  });
  const tool = async (name, args, timeoutMs) => {
    const m = await request('tools/call', { name, arguments: args }, timeoutMs);
    if (m.error) throw new Error(`tools/call ${name}: error JSON-RPC ${m.error.message}`);
    return m.result;
  };
  const close = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.stdin.end();
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* gone */ } }, 3000).unref();
  });
  return { child, send, request, tool, close, transcript, stray, stderr: () => stderr };
}

/* Peticion cruda al socket: devuelve la primera linea de respuesta */
function rawRequest(socket, obj) {
  return new Promise((resolve, reject) => {
    const c = net.connect(socket);
    let buf = '';
    const t = setTimeout(() => { c.destroy(); reject(new Error('sin respuesta del socket')); }, 5000);
    c.setEncoding('utf-8');
    c.on('connect', () => c.write(`${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n`));
    c.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl >= 0) { clearTimeout(t); c.destroy(); resolve(JSON.parse(buf.slice(0, nl))); }
    });
    c.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

const textOf = (r) => (r && r.content && r.content[0] && r.content[0].text) || '';

async function seccionAgent({ check, ROOT }) {
  const storeService = require(path.join(ROOT, 'electron', 'services', 'store-service.js'));
  const agentMod = require(path.join(ROOT, 'electron', 'agent', 'agent-service.js'));
  const agent = agentMod;
  const { parseKnownHosts } = require(path.join(ROOT, 'electron', 'services', 'known-hosts.js'));

  /* Corto: el socket tiene que caber en sun_path (108) */
  const dir = fs.mkdtempSync('/tmp/tlag-');
  const files = fs.mkdtempSync('/tmp/tlag-files-');
  const savedAuthSock = process.env.SSH_AUTH_SOCK;
  delete process.env.SSH_AUTH_SOCK;   // si no, ssh2 prueba el agente real del usuario

  /* Todo lo que sale hacia fuera, para buscar secretos al final */
  const salida = [];
  const pushes = [];
  agent.broadcast = (ch, data) => { pushes.push([ch, data]); salida.push(JSON.stringify([ch, data])); };
  const consola = [];
  const realErr = console.error; const realLog = console.log; const realWarn = console.warn;
  const tap = (real) => (...a) => { consola.push(a.map(String).join(' ')); real(...a); };
  console.error = tap(realErr); console.log = tap(realLog); console.warn = tap(realWarn);

  let sshd = null;
  let mcp = null;
  let privateKey = '';
  const ids = {};
  try {
    try {
      sshd = await startRealSshd();
    } catch (err) {
      await check('AG0 sshd real disponible', () => { throw new Error(`sin sshd: ${err.message}`); });
    }

    // ── preparar: hosts con la clave del sshd, otro con contrasena centinela ──
    if (sshd) {
      privateKey = sshd.privateKey;
      const key = await storeService.saveKey({ name: 'AG key', privateKey: sshd.privateKey, type: 'ed25519' });
      const mk = async (h) => (await storeService.saveHost({ groupId: null, tags: [], ...h })).id;
      ids.key = await mk({ label: 'AG Server', hostname: '127.0.0.1', port: sshd.port, username: sshd.user, authType: 'key', keyId: key.id, passphrase: SECRET_PP, tags: ['ag', 'test'] });
      ids.pw = await mk({ label: 'AG Password', hostname: '127.0.0.1', port: sshd.port, username: sshd.user, authType: 'password', password: SECRET_PW });
      ids.unknown = await mk({ label: 'AG Localhost', hostname: 'localhost', port: sshd.port, username: sshd.user, authType: 'key', keyId: key.id });
      ids.dup1 = await mk({ label: 'AG Twin', hostname: '127.0.0.1', port: sshd.port, username: sshd.user, authType: 'key', keyId: key.id });
      ids.dup2 = await mk({ label: 'ag twin', hostname: '127.0.0.1', port: sshd.port, username: sshd.user, authType: 'key', keyId: key.id });
      const kh = parseKnownHosts(`[127.0.0.1]:${sshd.port} ${sshd.hostPublicKey}\n`).entries[0];
      await storeService.saveKnownHost(kh);
    }

    const st = await agent.start({ userDataDir: dir });
    const sock = path.join(dir, 'agent.sock');
    const tokenFile = path.join(dir, 'agent-token');

    await check('AG1 socket 0600, carpeta 0700, token 0600 de 64 hex', () => {
      assert.ok(st.listening, `no escucha: ${JSON.stringify(st)}`);
      const m = (p) => fs.statSync(p).mode & 0o777;
      assert.ok(fs.statSync(sock).isSocket(), 'agent.sock no es un socket');
      assert.strictEqual(m(sock).toString(8), '600', 'modo del socket');
      assert.strictEqual(m(dir).toString(8), '700', 'modo de la carpeta');
      assert.strictEqual(m(tokenFile).toString(8), '600', 'modo del token');
      assert.match(fs.readFileSync(tokenFile, 'utf-8').trim(), /^[0-9a-f]{64}$/);
      assert.ok(!fs.readFileSync(path.join(ROOT, 'electron', 'agent', 'agent-service.js'), 'utf-8').match(/\.listen\(\s*\d|createServer\([^)]*\)\.listen\(\s*\d/), 'algo escucha en un puerto TCP');
    });
    const token = fs.readFileSync(tokenFile, 'utf-8').trim();

    await check('AG2 token malo o ausente: rechazado; el bueno pasa', async () => {
      const bad = await rawRequest(sock, { id: 1, token: 'f'.repeat(64), method: 'list_hosts' });
      assert.strictEqual(bad.error && bad.error.code, 'unauthorized', JSON.stringify(bad));
      assert.ok(!bad.result, 'devolvio resultado con token malo');
      const none = await rawRequest(sock, { id: 2, method: 'run_command', params: { host: 'local', command: 'touch /tmp/no-deberia' } });
      assert.strictEqual(none.error && none.error.code, 'unauthorized');
      await new Promise(r => setTimeout(r, 300));
      assert.ok(!fs.existsSync('/tmp/no-deberia'), 'sin token se ejecuto el comando');
      const ok = await rawRequest(sock, { id: 3, token, method: 'hello' });
      assert.strictEqual(ok.result && ok.result.app, 'termilab', JSON.stringify(ok));
    });

    await check('AG3 segundo arranque con el socket vivo: no lo roba', async () => {
      const otro = new agentMod.AgentService();
      const r = await otro.start({ userDataDir: dir });
      assert.strictEqual(r.listening, false);
      const ok = await rawRequest(sock, { id: 4, token, method: 'hello' });
      assert.strictEqual(ok.result.pid, process.pid);
    });

    mcp = mcpClient(ROOT, { TERMILAB_USER_DATA: dir });

    await check('AG4 MCP stdio: initialize (legacy), discover (moderno), tools/list, version no soportada', async () => {
      const init = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'arnes', version: '1' } });
      assert.strictEqual(init.result.protocolVersion, '2025-06-18');
      assert.ok(init.result.capabilities.tools, 'sin capability tools');
      assert.strictEqual(init.result.serverInfo.name, 'termilab');
      mcp.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const odd = await mcp.request('initialize', { protocolVersion: '1999-01-01' });
      assert.strictEqual(odd.result.protocolVersion, '2025-11-25', 'version desconocida: debe ofrecer la ultima legacy');
      const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'arnes', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} };
      const disc = await mcp.request('server/discover', { _meta: meta });
      assert.ok(disc.result.supportedVersions.includes('2026-07-28'));
      assert.strictEqual(disc.result.resultType, 'complete');
      const list = await mcp.request('tools/list', { _meta: meta });
      assert.strictEqual(list.result.resultType, 'complete');
      const names = list.result.tools.map(t => t.name).sort();
      assert.deepStrictEqual(names, ['close_shell', 'list_hosts', 'open_shell', 'read_file', 'read_output', 'run_command', 'send_input', 'write_file']);
      for (const t of list.result.tools) assert.strictEqual(t.inputSchema.type, 'object', `${t.name} sin inputSchema object`);
      const unsup = await mcp.request('tools/list', { _meta: { ...meta, 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } });
      assert.strictEqual(unsup.error && unsup.error.code, -32022);
      assert.ok(unsup.error.data.supported.includes('2026-07-28'));
      const nope = await mcp.request('nada/de/esto', {});
      assert.strictEqual(nope.error.code, -32601);
      const badTool = await mcp.request('tools/call', { name: 'rm_rf', arguments: {} });
      assert.strictEqual(badTool.error.code, -32602);
      assert.deepStrictEqual(mcp.stray, [], `stdout trajo algo que no es una respuesta: ${mcp.stray.join(' | ')}`);
    });

    await check('AG5 list_hosts: nombres, grupo, tags, hostname/puerto, "local"; nunca credenciales', async () => {
      const r = await mcp.tool('list_hosts', {});
      assert.ok(!r.isError, textOf(r));
      const hosts = r.structuredContent.hosts;
      assert.ok(hosts.find(h => h.id === 'local'), 'falta local');
      if (sshd) {
        const h = hosts.find(x => x.id === ids.key);
        assert.ok(h, 'falta AG Server');
        assert.deepStrictEqual([h.name, h.hostname, h.port, h.user, h.auth], ['AG Server', '127.0.0.1', sshd.port, sshd.user, 'key']);
        assert.deepStrictEqual(h.tags, ['ag', 'test']);
        const allowed = new Set(['id', 'name', 'group', 'tags', 'os', 'user', 'hostname', 'port', 'auth', 'available', 'note']);
        for (const x of hosts) for (const k of Object.keys(x)) assert.ok(allowed.has(k), `campo inesperado ${k}`);
      }
      salida.push(JSON.stringify(r));
    });

    if (sshd) {
      await check('AG6 run_command contra sshd real: salida, stderr y codigo de salida', async () => {
        const r = await mcp.tool('run_command', { host: 'AG Server', command: 'uname -a; echo al-stderr >&2; exit 3' });
        salida.push(JSON.stringify(r));
        assert.ok(!r.isError, textOf(r));
        const s = r.structuredContent;
        assert.strictEqual(s.exit_code, 3);
        assert.match(s.stdout, /Linux/);
        assert.strictEqual(s.stderr.trim(), 'al-stderr');
        assert.strictEqual(s.truncated, false);
        const byId = await mcp.tool('run_command', { host: ids.key, command: 'pwd', cwd: files });
        assert.strictEqual(byId.structuredContent.stdout.trim(), fs.realpathSync(files), 'cwd no aplicado');
        const ci = await mcp.tool('run_command', { host: 'ag server', command: 'echo $((1234*1000+567))' });
        assert.strictEqual(ci.structuredContent.stdout.trim(), '1234567');
        salida.push(JSON.stringify(byId), JSON.stringify(ci));
      });

      await check('AG7 host key desconocida: rechazada, sin preguntar y sin escribir known hosts', async () => {
        const before = JSON.stringify(await storeService.getKnownHosts());
        const r = await mcp.tool('run_command', { host: 'AG Localhost', command: 'echo no' });
        salida.push(JSON.stringify(r));
        assert.ok(r.isError, 'paso con una clave desconocida');
        assert.match(textOf(r), /not trusted the host key/);
        assert.match(textOf(r), /connect to it once/);
        assert.strictEqual(JSON.stringify(await storeService.getKnownHosts()), before, 'known hosts cambio');
      });

      await check('AG8 host key cambiada: rechazada con aviso de MITM', async () => {
        const kdir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlag-k-'));
        execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(kdir, 'k')]);
        const other = fs.readFileSync(path.join(kdir, 'k.pub'), 'utf-8').trim();
        fs.rmSync(kdir, { recursive: true, force: true });
        await storeService.saveKnownHost(parseKnownHosts(`[localhost]:${sshd.port} ${other}\n`).entries[0]);
        const before = JSON.stringify(await storeService.getKnownHosts());
        const r = await mcp.tool('run_command', { host: 'AG Localhost', command: 'echo no' });
        salida.push(JSON.stringify(r));
        assert.ok(r.isError, 'paso con una clave cambiada');
        assert.match(textOf(r), /CHANGED/);
        assert.strictEqual(JSON.stringify(await storeService.getKnownHosts()), before, 'known hosts cambio');
      });

      await check('AG9 topes de salida (256 KB por flujo) y timeout', async () => {
        const big = await mcp.tool('run_command', { host: 'AG Server', command: "head -c 400000 /dev/zero | tr '\\0' a; head -c 300000 /dev/zero | tr '\\0' b >&2" });
        const s = big.structuredContent;
        assert.strictEqual(s.stdout.length, 256 * 1024);
        assert.strictEqual(s.stderr.length, 256 * 1024);
        assert.strictEqual(s.truncated, true);
        assert.deepStrictEqual([s.stdout_bytes, s.stderr_bytes], [400000, 300000]);
        const t0 = Date.now();
        const slow = await mcp.tool('run_command', { host: 'AG Server', command: 'sleep 30; echo tarde', timeout_s: 1 });
        assert.strictEqual(slow.structuredContent.timed_out, true);
        assert.ok(Date.now() - t0 < 8000, `tardo ${Date.now() - t0} ms`);
        assert.ok(!slow.structuredContent.stdout.includes('tarde'));
      });

      await check('AG10 shell interactiva remota: ida y vuelta, badge (status) y cierre', async () => {
        pushes.length = 0;
        const o = await mcp.tool('open_shell', { host: 'AG Server' });
        assert.ok(!o.isError, textOf(o));
        const sid = o.structuredContent.session_id;
        assert.match(sid, /^sh_[0-9a-f]{18}$/);
        const st1 = pushes.filter(p => p[0] === 'agent:status').pop();
        assert.ok(st1 && st1[1].shells.some(x => x.session_id === sid && x.host === 'AG Server'), 'sin push de status con la shell');
        await mcp.tool('read_output', { session_id: sid, wait_ms: 3000 });
        await mcp.tool('send_input', { session_id: sid, data: 'echo resultado-$((6*7))\r' });
        let seen = '';
        for (let i = 0; i < 10 && !seen.includes('resultado-42'); i++) {
          seen += (await mcp.tool('read_output', { session_id: sid, wait_ms: 2000 })).structuredContent.output;
        }
        assert.ok(seen.includes('resultado-42'), `no llego la salida: ${JSON.stringify(seen.slice(-200))}`);
        await mcp.tool('send_input', { session_id: sid, data: 'exit 4\r' });
        let last = null;
        for (let i = 0; i < 10; i++) {
          last = (await mcp.tool('read_output', { session_id: sid, wait_ms: 2000 })).structuredContent;
          if (last.closed) break;
        }
        assert.ok(last.closed, 'la shell no se cerro');
        assert.strictEqual(last.exit_code, 4);
        const gone = await mcp.tool('read_output', { session_id: sid });
        assert.ok(gone.isError, 'sesion cerrada sigue legible');
        const st2 = pushes.filter(p => p[0] === 'agent:status').pop();
        assert.ok(!st2[1].shells.some(x => x.session_id === sid), 'el status sigue con la shell cerrada');
        salida.push(seen);
      });

      await check('AG11 shell inactiva se cierra sola', async () => {
        const o = await mcp.tool('open_shell', { host: 'AG Server' });
        const sid = o.structuredContent.session_id;
        const idle = agent.idleMs;
        agent.idleMs = 0;
        agent.shells.get(sid).lastActive = Date.now() - 10;
        agent._closeIdle();
        agent.idleMs = idle;
        assert.ok(!agent.shells.has(sid));
        assert.ok((await mcp.tool('send_input', { session_id: sid, data: 'x' })).isError);
      });

      await check('AG12 read_file / write_file por SFTP (modo, binario, tope)', async () => {
        const target = path.join(files, 'nota.txt');
        const w = await mcp.tool('write_file', { host: 'AG Server', path: target, content: 'hola ñandú\n', mode: '600' });
        assert.ok(!w.isError, textOf(w));
        assert.strictEqual(fs.readFileSync(target, 'utf-8'), 'hola ñandú\n');
        assert.strictEqual((fs.statSync(target).mode & 0o777).toString(8), '600');
        const r = await mcp.tool('read_file', { host: 'AG Server', path: target });
        assert.deepStrictEqual([r.structuredContent.content, r.structuredContent.encoding, r.structuredContent.truncated], ['hola ñandú\n', 'utf-8', false]);
        fs.writeFileSync(path.join(files, 'bin'), Buffer.from([0, 255, 254, 1, 2, 3]));
        const b = await mcp.tool('read_file', { host: 'AG Server', path: path.join(files, 'bin') });
        assert.strictEqual(b.structuredContent.encoding, 'base64');
        assert.deepStrictEqual([...Buffer.from(b.structuredContent.content, 'base64')], [0, 255, 254, 1, 2, 3]);
        fs.writeFileSync(path.join(files, 'big'), 'x'.repeat(5000));
        const t = await mcp.tool('read_file', { host: 'AG Server', path: path.join(files, 'big'), max_bytes: 100 });
        assert.deepStrictEqual([t.structuredContent.content.length, t.structuredContent.truncated, t.structuredContent.size], [100, true, 5000]);
        const tooBig = await mcp.tool('write_file', { host: 'AG Server', path: path.join(files, 'x'), content: 'y'.repeat(4 * 1024 * 1024 + 1) }, 60000);
        assert.ok(tooBig.isError && /larger than/.test(textOf(tooBig)));
        const missing = await mcp.tool('read_file', { host: 'AG Server', path: path.join(files, 'no-existe') });
        assert.ok(missing.isError);
      });

      await check('AG13 resolucion de host: ambiguo lista ids, desconocido, por id', async () => {
        const amb = await mcp.tool('run_command', { host: 'AG TWIN', command: 'true' });
        assert.ok(amb.isError);
        assert.ok(textOf(amb).includes(ids.dup1) && textOf(amb).includes(ids.dup2), textOf(amb));
        const none = await mcp.tool('run_command', { host: 'no-existe-este', command: 'true' });
        assert.ok(none.isError && /list_hosts/.test(textOf(none)));
        const one = await mcp.tool('run_command', { host: ids.dup2, command: 'echo $((40+2))' });
        assert.strictEqual(one.structuredContent.stdout.trim(), '42');
      });

      await check('AG14 host sellado por otro equipo: error claro, list_hosts lo marca', async () => {
        const syncService = require(path.join(ROOT, 'electron', 'services', 'sync-service.js'));
        const real = syncService.status;
        syncService.status = async () => ({ undecryptableIds: [`hosts/${ids.key}`] });
        try {
          const r = await mcp.tool('run_command', { host: 'AG Server', command: 'true' });
          assert.ok(r.isError && /cannot be decrypted/.test(textOf(r)), textOf(r));
          const l = await mcp.tool('list_hosts', {});
          const h = l.structuredContent.hosts.find(x => x.id === ids.key);
          assert.strictEqual(h.available, false);
          salida.push(JSON.stringify(r), JSON.stringify(l));
        } finally {
          syncService.status = real;
        }
      });

      await check('AG15 host con contrasena: el fallo no la menciona', async () => {
        const r = await mcp.tool('run_command', { host: 'AG Password', command: 'true' });
        salida.push(JSON.stringify(r));
        assert.ok(r.isError, 'el sshd del arnes no admite contrasena: tenia que fallar');
        assert.match(textOf(r), /Authentication|failed/);
      });
    }

    await check('AG16 "local": comando, cwd, codigo de salida y shell con pty', async () => {
      const r = await mcp.tool('run_command', { host: 'local', command: 'echo local-$((2+3)); pwd; exit 5', cwd: files });
      assert.ok(!r.isError, textOf(r));
      assert.strictEqual(r.structuredContent.exit_code, 5);
      assert.deepStrictEqual(r.structuredContent.stdout.trim().split('\n'), ['local-5', fs.realpathSync(files)]);
      const o = await mcp.tool('open_shell', { host: 'local' });
      assert.ok(!o.isError, textOf(o));
      const sid = o.structuredContent.session_id;
      await mcp.tool('read_output', { session_id: sid, wait_ms: 1500 });
      await mcp.tool('send_input', { session_id: sid, data: 'echo pty-$((3*3)); tty\r' });
      let seen = '';
      for (let i = 0; i < 10 && !/pty-9[\s\S]*\/dev\/pts\//.test(seen); i++) {
        seen += (await mcp.tool('read_output', { session_id: sid, wait_ms: 2000 })).structuredContent.output;
      }
      assert.match(seen, /pty-9[\s\S]*\/dev\/pts\//, `sin pty: ${JSON.stringify(seen.slice(-200))}`);
      await mcp.tool('close_shell', { session_id: sid });
      assert.ok(!agent.shells.has(sid));
      const w = await mcp.tool('write_file', { host: 'local', path: path.join(files, 'l.txt'), content: 'loc', mode: '640' });
      assert.ok(!w.isError, textOf(w));
      assert.strictEqual((fs.statSync(path.join(files, 'l.txt')).mode & 0o777).toString(8), '640');
      const rf = await mcp.tool('read_file', { host: 'local', path: path.join(files, 'l.txt') });
      assert.strictEqual(rf.structuredContent.content, 'loc');
    });

    await check('AG17 "local" con no_new_privs: el comando corre con NoNewPrivs 0', async () => {
      if (process.platform !== 'linux') return;
      let state = '';
      try { state = execFileSync('systemctl', ['--user', 'is-system-running'], { encoding: 'utf-8' }).trim(); } catch (e) { state = String(e.stdout || '').trim(); }
      if (!['running', 'degraded'].includes(state)) { console.log('  AG17 OMITIDA: sin systemd --user'); return; }
      const out = execFileSync('setpriv', ['--no-new-privs', process.execPath, path.join(ROOT, 'scripts', 'lib', 'agent-local-driver.js')], {
        encoding: 'utf-8', env: { ...process.env, TERMILAB_DIRECT_PTY: '' }, timeout: 30000,
      });
      const r = JSON.parse(out.trim().split('\n').pop());
      assert.strictEqual(r.self, '1', 'el driver no corre con NNP=1: la prueba no prueba nada');
      assert.strictEqual(r.command, '0', `el comando hereda NNP: ${JSON.stringify(r)}`);
      assert.strictEqual(r.exit, 0);
    });

    await check('AG18 cada accion queda en el log de agentes (0600), sin la salida', async () => {
      await agent.log.flush();
      const file = path.join(dir, 'data', 'agent-logs.json');
      assert.strictEqual((fs.statSync(file).mode & 0o777).toString(8), '600');
      const list = JSON.parse(fs.readFileSync(file, 'utf-8'));
      assert.ok(list.every(e => e.type === 'agent'));
      const run = list.find(e => e.tool === 'run_command' && e.command === 'echo local-$((2+3)); pwd; exit 5');
      assert.ok(run, 'falta el run_command local');
      assert.deepStrictEqual([run.host, run.exitCode, run.ok], ['local', 5, true]);
      assert.ok(Number.isFinite(run.durationMs));
      if (sshd) {
        const remote = list.find(e => e.tool === 'run_command' && e.host === 'AG Server' && e.exitCode === 3);
        assert.ok(remote && remote.hostId === ids.key && remote.hostname === '127.0.0.1', 'falta el remoto con su host');
        assert.ok(list.some(e => e.tool === 'run_command' && e.host === 'AG Localhost' && !e.ok && /trusted/.test(e.error)), 'falta el rechazo de host key');
        assert.ok(list.some(e => e.tool === 'open_shell') && list.some(e => e.tool === 'send_input'), 'faltan las de shell');
        const raw = fs.readFileSync(file, 'utf-8');
        assert.ok(!raw.includes('1234567'), 'la salida de un comando llego al log');
        assert.ok(!raw.includes('hola ñandú'), 'el contenido de un write_file llego al log');
      }
      const ag = await (require(path.join(ROOT, 'electron', 'agent', 'agent-service.js')).log.list());
      assert.strictEqual(ag.length, list.length);
    });

    await check('AG19 ningun secreto en resultados, transcript MCP, logs, consola ni pushes', async () => {
      await agent.log.flush();
      const logRaw = fs.readFileSync(path.join(dir, 'data', 'agent-logs.json'), 'utf-8');
      const haystacks = { transcript: mcp.transcript.join('\n'), stderrMcp: mcp.stderr(), salida: salida.join('\n'), log: logRaw, consola: consola.join('\n') };
      const keyLines = privateKey.split('\n').filter(l => l.length > 20 && !l.startsWith('-----'));
      for (const [name, text] of Object.entries(haystacks)) {
        assert.ok(!text.includes(SECRET_PW), `contrasena en ${name}`);
        assert.ok(!text.includes(SECRET_PP), `passphrase en ${name}`);
        for (const l of keyLines) assert.ok(!text.includes(l), `clave privada en ${name}`);
        assert.ok(!text.includes(token), `token del agente en ${name}`);
      }
      assert.ok(haystacks.transcript.length > 1000, 'transcript vacio: la busqueda no busca nada');
    });

    await check('AG20 una sola funcion de politica (agentMayUse), consultada en cada herramienta con host', () => {
      const src = fs.readFileSync(path.join(ROOT, 'electron', 'agent', 'agent-service.js'), 'utf-8');
      assert.strictEqual((src.match(/^function agentMayUse/mg) || []).length, 1);
      assert.match(src, /async _target\(spec\) \{\s*const t = await this\._resolve\(spec\);\s*const policy = agentMayUse\(t\);/);
      assert.ok(!/this\._resolve\(p\.host\)/.test(src), 'una herramienta resuelve el host sin pasar por _target');
    });

    await check('AG22 mcp.js sale ya al cerrarse stdin (con un run_command en vuelo) y con SIGTERM', async () => {
      const exitIn = (c) => new Promise((resolve) => {
        if (c.child.exitCode !== null) return resolve(c.child.exitCode);
        const t = setTimeout(() => resolve('sigue vivo'), 2000);
        c.child.once('exit', (code) => { clearTimeout(t); resolve(code); });
      });
      const a = mcpClient(ROOT, { TERMILAB_USER_DATA: dir });
      a.request('tools/call', { name: 'run_command', arguments: { host: 'local', command: 'sleep 20' } }).catch(() => {});
      await new Promise(r => setTimeout(r, 300));
      const t0 = Date.now();
      a.child.stdin.end();
      assert.strictEqual(await exitIn(a), 0, 'no salio al cerrar stdin');
      assert.ok(Date.now() - t0 < 1500, `tardo ${Date.now() - t0} ms`);
      const b = mcpClient(ROOT, { TERMILAB_USER_DATA: dir });
      await b.request('ping', {});
      b.child.kill('SIGTERM');
      const code = await exitIn(b);
      assert.ok(code === 0 || code === null, `SIGTERM: ${code}`);
      assert.deepStrictEqual([...a.stray, ...b.stray], [], 'stdout trajo algo que no es JSON-RPC');
    });

    await check('AG21 Termilab cerrado: herramientas dicen "Open Termilab first", socket borrado', async () => {
      await agent.stop();
      assert.ok(!fs.existsSync(sock), 'el socket sigue en disco');
      const r = await mcp.tool('list_hosts', {});
      assert.ok(r.isError && /Open Termilab first/.test(textOf(r)), textOf(r));
      fs.writeFileSync(sock, '');   // un socket viejo que no es socket
      const r2 = await mcp.tool('run_command', { host: 'local', command: 'true' });
      assert.ok(r2.isError && /Open Termilab first/.test(textOf(r2)), textOf(r2));
      fs.unlinkSync(sock);
      const nodir = mcpClient(ROOT, { TERMILAB_USER_DATA: path.join(dir, 'no-existe') });
      try {
        const r3 = await nodir.tool('list_hosts', {});
        assert.ok(r3.isError && /Open Termilab first/.test(textOf(r3)));
      } finally { await nodir.close(); }
    });
  } finally {
    console.error = realErr; console.log = realLog; console.warn = realWarn;
    try { await agent.stop(); } catch (_) { /* ya parado */ }
    if (mcp) await mcp.close();
    if (sshd) await sshd.stop();
    if (savedAuthSock !== undefined) process.env.SSH_AUTH_SOCK = savedAuthSock;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(files, { recursive: true, force: true });
    await fsp.rm('/tmp/no-deberia', { force: true });
  }
}

module.exports = { seccionAgent, mcpClient };
