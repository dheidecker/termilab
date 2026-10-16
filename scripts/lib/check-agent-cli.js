/**
 * Seccion AG, segunda parte: `termilab-cli` (electron/agent/cli.js) y que el
 * servidor MCP se explique solo (instructions, descripciones, guia). La llama
 * scripts/lib/check-agent.js con el servicio escuchando en este proceso y el
 * sshd real arriba.
 *
 * OJO: el CLI se lanza con spawn ASINCRONO. Con spawnSync el bucle de eventos
 * de este proceso (que es el que sirve el socket) se bloquea y el CLI espera
 * para siempre.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/* Corre el CLI con node; devuelve { code, stdout (Buffer), stderr, ms } */
function cli(ROOT, env, args, input) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [path.join(ROOT, 'electron', 'agent', 'cli.js'), ...args], {
      env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out = []; let err = '';
    child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`termilab-cli ${args.join(' ')}: sin terminar`)); }, 30000);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, stdout: Buffer.concat(out), stderr: err, ms: Date.now() - t0 }); });
    child.stdin.end(input === undefined ? '' : input);
  });
}

async function checksCliRunning({ check, ROOT, dir, files, sshd, salida }) {
  const env = { TERMILAB_USER_DATA: dir };
  const run = (args, input) => cli(ROOT, env, args, input).then((r) => {
    salida.push(r.stdout.toString('utf-8'), r.stderr);
    return r;
  });

  await check('AG23 termilab-cli hosts: tabla y --json, sin credenciales', async () => {
    const t = await run(['hosts']);
    assert.strictEqual(t.code, 0, t.stderr);
    const text = t.stdout.toString();
    assert.match(text.split('\n')[0], /^NAME\s+GROUP\s+TARGET\s+OS$/);
    assert.match(text, new RegExp(`AG Server\\s+-\\s+\\S+@127\\.0\\.0\\.1:${sshd.port}`));
    assert.match(text, /^local\s/m);
    const j = await run(['hosts', '--json']);
    assert.strictEqual(j.code, 0, j.stderr);
    const parsed = JSON.parse(j.stdout.toString());
    assert.ok(Array.isArray(parsed.hosts) && parsed.hosts.some(h => h.name === 'AG Server'));
    const allowed = new Set(['id', 'name', 'group', 'tags', 'os', 'user', 'hostname', 'port', 'auth', 'available', 'note']);
    for (const h of parsed.hosts) for (const k of Object.keys(h)) assert.ok(allowed.has(k), `campo inesperado ${k}`);
  });

  await check('AG24 termilab-cli run: stdout/stderr separados y codigo de salida remoto propagado', async () => {
    const r = await run(['run', 'AG Server', 'echo fuera; echo error >&2; exit 7']);
    assert.strictEqual(r.code, 7, `codigo ${r.code}; ${r.stderr}`);
    assert.strictEqual(r.stdout.toString(), 'fuera\n');
    assert.strictEqual(r.stderr, 'error\n');
    const words = await run(['run', '--cwd', files, 'AG Server', 'pwd', '&&', 'echo', 'hola', 'mundo']);
    assert.strictEqual(words.code, 0, words.stderr);
    assert.strictEqual(words.stdout.toString(), `${fs.realpathSync(files)}\nhola mundo\n`);
    const passthru = await run(['run', 'AG Server', 'ls', '-la', files]);
    assert.strictEqual(passthru.code, 0, `ls -la se trago la opcion: ${passthru.stderr}`);
    const j = await run(['run', '--json', 'local', 'echo json; exit 3']);
    assert.strictEqual(j.code, 3);
    const obj = JSON.parse(j.stdout.toString());
    assert.strictEqual(obj.exit_code, 3);
    assert.strictEqual(obj.stdout, 'json\n');
    assert.strictEqual(obj.timed_out, false);
  });

  await check('AG25 termilab-cli run --timeout: sale con 124 y a tiempo', async () => {
    const r = await run(['run', '--timeout', '1', 'AG Server', 'sleep 20']);
    assert.strictEqual(r.code, 124, `codigo ${r.code}; ${r.stderr}`);
    assert.match(r.stderr, /timed out after 1 s/);
    assert.ok(r.ms < 10000, `tardo ${r.ms} ms`);
  });

  await check('AG26 termilab-cli write | read: ida y vuelta binaria por SFTP, --mode', async () => {
    const bytes = Buffer.concat([Buffer.from([0, 255, 254, 10, 13, 128]), Buffer.from('texto ñ\n'.repeat(3000))]);
    const target = path.join(files, 'cli-ida-vuelta.bin');
    const w = await run(['write', '--mode', '600', 'AG Server', target], bytes);
    assert.strictEqual(w.code, 0, w.stderr);
    assert.ok(fs.readFileSync(target).equals(bytes), 'el archivo escrito no coincide');
    assert.strictEqual((fs.statSync(target).mode & 0o777).toString(8), '600');
    const r = await run(['read', 'AG Server', target]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.ok(r.stdout.equals(bytes), `read devolvio ${r.stdout.length} bytes, se esperaban ${bytes.length}`);
    const cut = await run(['read', '--max-bytes', '10', 'AG Server', target]);
    assert.strictEqual(cut.code, 1);
    assert.strictEqual(cut.stdout.length, 10);
    assert.match(cut.stderr, /printed only the first 10/);
  });

  await check('AG27 termilab-cli: host desconocido sugiere nombres; host key no confiada = 125 y "connect once"', async () => {
    const u = await run(['run', 'AG Servr', 'true']);
    assert.strictEqual(u.code, 125);
    assert.match(u.stderr, /no host named "AG Servr".*Did you mean: "AG Server"/);
    const k = await run(['run', 'AG Localhost', 'echo no']);
    assert.strictEqual(k.code, 125);
    assert.match(k.stderr, /connect to it once/);
    const rd = await run(['read', 'AG Servr', '/etc/hostname']);
    assert.strictEqual(rd.code, 1);
    assert.match(rd.stderr, /Did you mean/);
  });

  await check('AG28 termilab-cli --help / help <cmd> limpios; uso incorrecto = 2', async () => {
    const h = await run(['--help']);
    assert.strictEqual(h.code, 0);
    assert.strictEqual(h.stderr, '');
    assert.match(h.stdout.toString(), /Run `termilab-cli guide` for how AI agents should use this\.\n$/);
    for (const c of ['hosts', 'run', 'read', 'write', 'mcp', 'guide']) {
      const x = await run(['help', c]);
      assert.strictEqual(x.code, 0, c);
      assert.match(x.stdout.toString(), new RegExp(`^Usage: termilab-cli ${c}`));
      const y = await run([c, '--help']);
      assert.strictEqual(y.stdout.toString(), x.stdout.toString(), `${c} --help distinto de help ${c}`);
    }
    for (const bad of [['nada'], ['run', 'local'], ['run'], ['hosts', '--nope'], ['run', '--timeout', 'x', 'local', 'true'], ['write', '--mode', '9', 'local', '/tmp/x']]) {
      const x = await run(bad);
      assert.strictEqual(x.code, 2, `${bad.join(' ')} -> ${x.code}`);
      assert.strictEqual(x.stdout.length, 0, `${bad.join(' ')} escribio en stdout`);
    }
    const { GUIDE } = require(path.join(ROOT, 'electron', 'agent', 'guide.js'));
    const g = await run(['guide']);
    assert.strictEqual(g.stdout.toString(), GUIDE);
  });

  await check('AG29 termilab-cli mcp: el mismo servidor MCP (initialize, tools/list, guia)', async () => {
    const child = spawn(process.execPath, [path.join(ROOT, 'electron', 'agent', 'cli.js'), 'mcp'], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = [];
    let buf = '';
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (d) => { buf += d; let nl; while ((nl = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, nl))); buf = buf.slice(nl + 1); } });
    const send = o => child.stdin.write(`${JSON.stringify(o)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '1' } } });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'run_command', arguments: { host: 'AG Server', command: 'echo por-mcp' } } });
    for (let i = 0; i < 100 && lines.length < 3; i++) await new Promise(r => setTimeout(r, 100));
    const code = await new Promise((resolve) => { child.once('exit', resolve); child.stdin.end(); });
    const by = Object.fromEntries(lines.map(l => [l.id, l]));
    assert.strictEqual(by[1].result.serverInfo.name, 'termilab');
    assert.ok(by[2].result.tools.length === 8);
    assert.strictEqual(by[3].result.structuredContent.stdout, 'por-mcp\n');
    assert.strictEqual(code, 0);
  });
}

async function checkCliNotRunning({ check, ROOT, dir }) {
  await check('AG30 termilab-cli con Termilab cerrado: "Termilab is not running", 1 (125 en run)', async () => {
    for (const [args, want] of [[['hosts'], 1], [['run', 'local', 'true'], 125], [['read', 'local', '/etc/hostname'], 1]]) {
      const r = await cli(ROOT, { TERMILAB_USER_DATA: dir }, args);
      assert.strictEqual(r.code, want, `${args.join(' ')} -> ${r.code}`);
      assert.match(r.stderr, /Termilab is not running\. Open Termilab first/);
      assert.strictEqual(r.stdout.length, 0);
    }
  });
}

/* Sin Termilab: lo que el servidor cuenta de si mismo a un agente que no sabe nada */
async function checksSelfDescribing({ check, ROOT }) {
  const mcp = require(path.join(ROOT, 'electron', 'agent', 'mcp.js'));
  const { GUIDE } = require(path.join(ROOT, 'electron', 'agent', 'guide.js'));

  await check('AG31 MCP se explica solo: instructions, descripcion en cada herramienta y propiedad, anotaciones', async () => {
    const init = await mcp.handle({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
    const ins = init.result.instructions;
    assert.ok(typeof ins === 'string' && ins.length > 500 && ins.length <= 2500, `instructions de ${ins && ins.length} caracteres`);
    for (const w of ['list_hosts', 'run_command', 'open_shell', 'send_input', 'read_output', 'close_shell', 'read_file', 'write_file', 'local', 'cwd', 'host key', 'not running']) {
      assert.ok(ins.includes(w), `instructions no menciona ${w}`);
    }
    const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' };
    const disc = await mcp.handle({ id: 2, method: 'server/discover', params: { _meta: meta } });
    assert.strictEqual(disc.result.instructions, ins, 'discover sin las mismas instructions');
    for (const t of mcp.TOOLS) {
      assert.ok(t.description && t.description.length > 60, `${t.name} sin descripcion util`);
      assert.ok(t.annotations, `${t.name} sin annotations`);
      for (const [k, v] of Object.entries(t.inputSchema.properties || {})) {
        assert.ok(typeof v.description === 'string' && v.description.trim().length > 10, `${t.name}.${k} sin descripcion`);
      }
    }
    const by = Object.fromEntries(mcp.TOOLS.map(t => [t.name, t.annotations]));
    for (const n of ['list_hosts', 'read_file', 'read_output']) assert.strictEqual(by[n].readOnlyHint, true, `${n} readOnlyHint`);
    for (const n of ['run_command', 'write_file', 'send_input']) assert.strictEqual(by[n].destructiveHint, true, `${n} destructiveHint`);
    for (const n of Object.keys(by)) assert.strictEqual(typeof by[n].openWorldHint, 'boolean', `${n} openWorldHint`);
  });

  await check('AG32 guia como recurso termilab://guide y prompt termilab_usage; docs/agents.md la contiene igual', async () => {
    const init = await mcp.handle({ id: 1, method: 'initialize', params: {} });
    assert.ok(init.result.capabilities.resources && init.result.capabilities.prompts);
    const list = await mcp.handle({ id: 2, method: 'resources/list', params: {} });
    assert.deepStrictEqual(list.result.resources.map(r => [r.uri, r.mimeType]), [['termilab://guide', 'text/markdown']]);
    const read = await mcp.handle({ id: 3, method: 'resources/read', params: { uri: 'termilab://guide' } });
    assert.strictEqual(read.result.contents[0].text, GUIDE);
    const miss = await mcp.handle({ id: 4, method: 'resources/read', params: { uri: 'termilab://otra' } });
    assert.strictEqual(miss.error.code, -32002);
    const pl = await mcp.handle({ id: 5, method: 'prompts/list', params: {} });
    assert.deepStrictEqual(pl.result.prompts.map(p => p.name), ['termilab_usage']);
    const pg = await mcp.handle({ id: 6, method: 'prompts/get', params: { name: 'termilab_usage' } });
    assert.ok(pg.result.messages[0].content.text.includes(GUIDE));
    const doc = fs.readFileSync(path.join(ROOT, 'docs', 'agents.md'), 'utf-8');
    const m = doc.match(/<!-- agent-guide:start[^>]*-->\n([\s\S]*?)<!-- agent-guide:end -->/);
    assert.ok(m, 'docs/agents.md sin los marcadores agent-guide');
    /* En el doc los titulos bajan dos niveles (## -> ####) para colgar de su seccion */
    const asDoc = GUIDE.replace(/^(#+) /mg, (_, h) => `${h}## `);
    assert.strictEqual(m[1], asDoc, 'docs/agents.md y electron/agent/guide.js se separaron: copia la guia otra vez');
  });

  await check('AG33 un solo cliente del socket: mcp.js y cli.js usan client.js, ninguno abre sockets por su cuenta', () => {
    for (const f of ['mcp.js', 'cli.js']) {
      const src = fs.readFileSync(path.join(ROOT, 'electron', 'agent', f), 'utf-8');
      assert.match(src, /require\('\.\/client'\)/, `${f} no usa client.js`);
      assert.ok(!/require\('net'\)|net\.connect|createConnection/.test(src), `${f} abre su propio socket`);
    }
  });
}

module.exports = { checksCliRunning, checkCliNotRunning, checksSelfDescribing, cli };
