/**
 * Seccion DX del arnes del main (scripts/check-main.js): comandos destructivos
 * de agentes de IA que esperan el "Run once" del usuario.
 *
 *  - DX1/DX2: tabla de electron/agent/destructive.js (positivos por categoria,
 *    con sudo/env, sh -c, ssh, docker exec, pipes, heredocs; negativos de
 *    solo lectura que no deben preguntar)
 *  - DX3: send_input, troceado de teclas (typedLines)
 *  - DX4-DX7: ida y vuelta con approval.js y un renderer falso (aprobar,
 *    bloquear, timeout, sin ventana, respuesta de otra ventana, ventana
 *    cerrada -> pasa a otra)
 *  - DX8-DX10: agent-service de verdad con "local": run_command bloqueado no
 *    ejecuta nada, aprobado ejecuta exactamente eso una vez, log con la
 *    categoria; send_input linea a linea con una shell pty real
 *  - DX11: la regla llega a los agentes (instructions, descripciones, guia, docs)
 *
 * Solo esta seccion: TERMILAB_CHECK_ONLY=DX node scripts/check-main.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { POSITIVE, NEGATIVE } = require('./destructive-cases');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* Ventana falsa al estilo window-registry: wc con send(), focused/liveWindows */
function fakeRouter() {
  const wins = [];
  const mk = (name, { focused = false } = {}) => {
    const sent = [];
    const wc = { name, destroyed: false, isDestroyed() { return this.destroyed; }, send: (ch, p) => sent.push([ch, p]) };
    const entry = { wc, win: { isFocused: () => focused }, name, sent };
    wins.push(entry);
    return entry;
  };
  const router = {
    focused: () => wins.find(e => !e.wc.destroyed && e.win.isFocused()) || wins.find(e => !e.wc.destroyed) || null,
    liveWindows: () => wins.filter(e => !e.wc.destroyed),
    sendTo: (wc, ch, p) => { if (wc.destroyed) return false; wc.send(ch, p); return true; },
  };
  return { router, mk, wins };
}

/* Espera hasta que fn() sea verdad */
async function until(fn, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(20); }
  return fn();
}

async function seccionDestructive({ check, ROOT }) {
  const destructive = require(path.join(ROOT, 'electron', 'agent', 'destructive.js'));
  const { ApprovalBroker } = require(path.join(ROOT, 'electron', 'agent', 'approval.js'));
  const agentMod = require(path.join(ROOT, 'electron', 'agent', 'agent-service.js'));

  await check(`DX1 classify: ${POSITIVE.length} comandos destructivos detectados con su categoria`, () => {
    assert.ok(POSITIVE.length >= 80, 'la tabla positiva se quedo corta');
    const cats = new Set(POSITIVE.map(([, c]) => c));
    assert.deepStrictEqual([...cats].sort(), ['data-volumes', 'databases', 'db-reset', 'projects']);
    const fallos = [];
    for (const [cmd, cat] of POSITIVE) {
      const r = destructive.classify(cmd, { host: 'x' });
      if (!r || r.category !== cat) fallos.push(`${JSON.stringify(cmd)} -> ${r ? r.category : 'null'} (esperaba ${cat})`);
      else if (!r.label || !r.reason) fallos.push(`${JSON.stringify(cmd)} sin label/reason`);
    }
    assert.deepStrictEqual(fallos, []);
  });

  await check(`DX2 classify: ${NEGATIVE.length} comandos de solo lectura o seguros pasan sin preguntar`, () => {
    assert.ok(NEGATIVE.length >= 60, 'la tabla negativa se quedo corta');
    const fallos = NEGATIVE.map(c => [c, destructive.classify(c)]).filter(([, r]) => r).map(([c, r]) => `${JSON.stringify(c)} -> ${r.category}: ${r.reason}`);
    assert.deepStrictEqual(fallos, []);
    /* Lo que va a una base de datos por una linea tecleada (send_input en psql) */
    assert.strictEqual(destructive.classifyDbText('DROP DATABASE ventas;').category, 'databases');
    assert.strictEqual(destructive.classifyDbText('FLUSHALL').category, 'databases');
    assert.strictEqual(destructive.classifyDbText('SELECT * FROM t WHERE x = 1;'), null);
    /* Nunca lanza: entrada rara -> null o un aviso, no una excepcion */
    for (const raw of ['', '"', "'", '$(', '<<', 'rm -rf "', '`', '\\', '(((', 'cat <<EOF']) destructive.classify(raw);
  });

  await check('DX3 send_input: teclas troceadas, Enter, Ctrl-C/Ctrl-U, borrado y escapes', () => {
    const { typedLines } = agentMod;
    assert.deepStrictEqual(typedLines('', 'rm -rf /sr'), { lines: [], rest: 'rm -rf /sr', reset: false });
    assert.deepStrictEqual(typedLines('rm -rf /sr', 'v\r').lines, ['rm -rf /srv']);
    assert.deepStrictEqual(typedLines('', 'a\r\nb\nc').lines, ['a', 'b']);
    assert.strictEqual(typedLines('', 'ls\nc').rest, 'c');
    assert.strictEqual(typedLines('rm -rf /srv', '\x15ls\r').lines[0], 'ls');
    assert.strictEqual(typedLines('x', '\x03').reset, true);
    assert.strictEqual(typedLines('', 'rm -rf /srvX\x7f\r').lines[0], 'rm -rf /srv');
    assert.strictEqual(typedLines('', '\x1b[A\x1bOBls\r').lines[0], 'ls');
    assert.ok(destructive.isIncomplete('psql <<EOF'));
    assert.ok(destructive.isIncomplete('mysql -e "DROP'));
    assert.ok(!destructive.isIncomplete('psql <<EOF\nDROP TABLE x;\nEOF'));
  });

  await check('DX4 approval: Run once -> aprobado; Block -> bloqueado; prompt con cliente, host, categoria y comando completo', async () => {
    const { router, mk } = fakeRouter();
    const a = mk('A', { focused: true });
    const presented = [];
    const b = new ApprovalBroker();
    b.setRouter(router);
    b.present = (entry, p) => presented.push([entry.name, p.requestId]);
    const big = `dropdb ventas # ${'x'.repeat(5000)}`;
    const p1 = b.ask({ client: 'Claude Code', host: 'produccion', tool: 'run_command', command: big, category: 'databases', label: 'database drop or wipe', reason: 'dropdb' });
    assert.ok(await until(() => a.sent.length === 1));
    const [ch, pay] = a.sent[0];
    assert.strictEqual(ch, 'agent:approval-prompt');
    assert.deepStrictEqual([pay.client, pay.host, pay.category, pay.command.length, pay.timeoutMs], ['Claude Code', 'produccion', 'databases', big.length, 120000]);
    assert.deepStrictEqual(presented, [['A', pay.requestId]], 'present() no se llamo con la ventana elegida');
    assert.strictEqual(b.respond(pay.requestId, true, a.wc), true);
    assert.deepStrictEqual(await p1, { approved: true, reason: 'approved' });
    assert.strictEqual(b.respond(pay.requestId, true, a.wc), false, 'una respuesta repetida cuenta');
    const p2 = b.ask({ host: 'h', command: 'git reset --hard', category: 'projects' });
    await until(() => a.sent.length === 2);
    b.respond(a.sent[1][1].requestId, false, a.wc);
    assert.deepStrictEqual(await p2, { approved: false, reason: 'blocked' });
    /* approve tiene que ser exactamente true */
    const p3 = b.ask({ host: 'h', command: 'x', category: 'projects' });
    await until(() => a.sent.length === 3);
    b.respond(a.sent[2][1].requestId, 'yes', a.wc);
    assert.strictEqual((await p3).approved, false, '"yes" aprobo');
    assert.strictEqual(b.pendingCount(), 0);
  });

  await check('DX5 approval: timeout -> bloqueado y el dialogo se cierra (cancel); sin ventana -> bloqueado al instante', async () => {
    const { router, mk } = fakeRouter();
    const b = new ApprovalBroker();
    b.setRouter(router);
    const t0 = Date.now();
    assert.deepStrictEqual(await b.ask({ host: 'h', command: 'dropdb x', category: 'databases' }), { approved: false, reason: 'no-window' });
    assert.ok(Date.now() - t0 < 200, 'sin ventana espero');
    const nobody = new ApprovalBroker();
    assert.strictEqual((await nobody.ask({ host: 'h', command: 'x' })).reason, 'no-window', 'sin router no bloqueo');
    const a = mk('A', { focused: true });
    b.timeoutMs = 150;
    const r = await b.ask({ host: 'h', command: 'dropdb x', category: 'databases' });
    assert.deepStrictEqual(r, { approved: false, reason: 'timeout' });
    assert.deepStrictEqual(a.sent.map(x => x[0]), ['agent:approval-prompt', 'agent:approval-cancel']);
    assert.strictEqual(a.sent[1][1].requestId, a.sent[0][1].requestId);
    /* Envio fallido (ventana destruida entre elegirla y mandar) */
    const dead = fakeRouter();
    const d = dead.mk('D', { focused: true });
    dead.router.sendTo = () => false;
    const b2 = new ApprovalBroker();
    b2.setRouter(dead.router);
    assert.strictEqual((await b2.ask({ host: 'h', command: 'x' })).reason, 'no-window');
    assert.strictEqual(d.sent.length, 0);
  });

  await check('DX6 approval: solo responde la ventana que pregunta; va a la enfocada', async () => {
    const { router, mk } = fakeRouter();
    const a = mk('A');
    const c = mk('C', { focused: true });
    const b = new ApprovalBroker();
    b.setRouter(router);
    const p = b.ask({ host: 'h', command: 'x', category: 'projects' });
    await until(() => c.sent.length === 1);
    assert.strictEqual(a.sent.length, 0, 'fue a la ventana no enfocada');
    const id = c.sent[0][1].requestId;
    assert.strictEqual(b.respond(id, true, a.wc), false, 'otra ventana pudo aprobar');
    assert.strictEqual(b.pendingCount(), 1);
    b.respond(id, true, c.wc);
    assert.strictEqual((await p).approved, true);
  });

  await check('DX7 approval: ventana cerrada -> el aviso pasa a otra; sin otra -> bloqueado; rejectAll al salir', async () => {
    const { router, mk } = fakeRouter();
    const a = mk('A', { focused: true });
    const c = mk('C');
    const b = new ApprovalBroker();
    b.setRouter(router);
    const p = b.ask({ host: 'h', command: 'x', category: 'projects' });
    await until(() => a.sent.length === 1);
    a.wc.destroyed = true;
    b.rejectFor(a.wc);
    assert.ok(await until(() => c.sent.length === 1), 'no paso a la otra ventana');
    assert.strictEqual(c.sent[0][1].requestId, a.sent[0][1].requestId);
    c.wc.destroyed = true;
    b.rejectFor(c.wc);
    assert.deepStrictEqual(await p, { approved: false, reason: 'no-window' });
    const live = mk('L', { focused: true });
    const q = b.ask({ host: 'h', command: 'x' });
    await until(() => live.sent.length === 1);
    b.rejectAll();
    assert.strictEqual((await q).approved, false);
  });

  /* ── agent-service de verdad, host "local" ── */
  const dir = fs.mkdtempSync('/tmp/tldx-');
  const svc = new agentMod.AgentService();
  svc.userDataDir = dir;
  const asks = [];
  let answer = { approved: false, reason: 'blocked' };
  let gate = null;
  svc.approver = { ask: async (info) => { asks.push(info); if (gate) await gate; return answer; }, rejectAll() {} };
  const marker = path.join(dir, 'ran');
  /* Clasificado como data-volumes; inofensivo: el volumen no existe (o no hay docker) */
  const cmd = `touch ${marker}; docker volume rm tldx-no-existe-${process.pid} >/dev/null 2>&1; echo ejecutado`;
  try {
    await check('DX8 run_command destructivo bloqueado: error "Blocked: ...", no se ejecuta nada, log con categoria', async () => {
      answer = { approved: false, reason: 'blocked' };
      let err = null;
      try { await svc.call('run_command', { host: 'local', command: cmd, cwd: dir }, { client: 'Arnes MCP' }); } catch (e) { err = e; }
      assert.ok(err, 'no fallo');
      assert.strictEqual(err.code, 'blocked');
      assert.strictEqual(err.message, 'Blocked: this command was classified as data volume removal and the user did not approve it. Do not retry or work around it; ask the user.');
      await sleep(300);
      assert.ok(!fs.existsSync(marker), 'el comando bloqueado se ejecuto');
      assert.strictEqual(asks.length, 1);
      assert.deepStrictEqual([asks[0].client, asks[0].host, asks[0].tool, asks[0].command, asks[0].category, asks[0].cwd], ['Arnes MCP', 'local', 'run_command', cmd, 'data-volumes', dir]);
      /* timeout del usuario: mismo error */
      answer = { approved: false, reason: 'timeout' };
      await assert.rejects(svc.call('run_command', { host: 'local', command: 'git reset --hard' }), /Blocked: this command was classified as project files or git history/);
      /* uno inofensivo no pregunta */
      const n = asks.length;
      const ok = await svc.call('run_command', { host: 'local', command: 'echo $((20+22))' });
      assert.strictEqual(ok.stdout.trim(), '42');
      assert.strictEqual(asks.length, n, 'pregunto por un comando inofensivo');
      await svc.log.flush();
      const log = await svc.log.list();
      const blocked = log.filter(e => e.tool === 'run_command (blocked)');
      assert.strictEqual(blocked.length, 2);
      assert.deepStrictEqual([blocked[0].category, blocked[0].ok, blocked[0].command], ['data-volumes', false, cmd]);
      assert.match(blocked[0].error, /data volume removal: the user blocked it/);
      assert.match(blocked[1].error, /no answer within 2 minutes/);
      assert.ok(!log.some(e => e.tool === 'run_command' && e.command === cmd), 'el bloqueado figura como ejecutado');
    });

    await check('DX9 run_command aprobado: se ejecuta exactamente ese comando, una vez; log approved + el run', async () => {
      answer = { approved: true, reason: 'approved' };
      let released;
      gate = new Promise(r => { released = r; });
      const call = svc.call('run_command', { host: 'local', command: cmd, cwd: dir }, { client: 'Arnes MCP' });
      await sleep(400);
      assert.ok(!fs.existsSync(marker), 'se ejecuto antes de la respuesta del usuario');
      released();
      gate = null;
      const r = await call;
      assert.strictEqual(r.stdout.trim(), 'ejecutado');
      assert.ok(fs.existsSync(marker));
      fs.unlinkSync(marker);
      /* "una vez": la siguiente vuelve a preguntar */
      answer = { approved: false, reason: 'blocked' };
      const n = asks.length;
      await assert.rejects(svc.call('run_command', { host: 'local', command: cmd }), /Blocked/);
      assert.strictEqual(asks.length, n + 1);
      assert.ok(!fs.existsSync(marker));
      await svc.log.flush();
      const log = await svc.log.list();
      const ap = log.find(e => e.tool === 'run_command (approved)');
      assert.ok(ap && ap.category === 'data-volumes' && ap.ok === true && ap.command === cmd, JSON.stringify(ap));
      assert.ok(log.some(e => e.tool === 'run_command' && e.command === cmd && e.ok), 'falta la entrada del run');
    });

    await check('DX10 send_input: linea a linea con una shell pty real; bloqueada no se escribe y se cancela lo tecleado', async () => {
      const o = await svc.call('open_shell', { host: 'local' });
      const sid = o.session_id;
      const read = async (want, tries = 12) => {
        let seen = '';
        for (let i = 0; i < tries && !want.test(seen); i++) seen += (await svc.call('read_output', { session_id: sid, wait_ms: 1500 })).output;
        return seen;
      };
      try {
        await read(/\S/, 3);
        answer = { approved: false, reason: 'blocked' };
        let n = asks.length;
        /* troceado: la primera mitad no tiene Enter y pasa */
        await svc.call('send_input', { session_id: sid, data: `touch ${marker}; docker volume ` });
        assert.strictEqual(asks.length, n, 'pregunto sin Enter');
        await assert.rejects(svc.call('send_input', { session_id: sid, data: `rm tldx-x >/dev/null 2>&1\r` }), /Blocked: this command was classified as data volume removal/);
        assert.strictEqual(asks.length, n + 1);
        assert.strictEqual(asks[asks.length - 1].command, `touch ${marker}; docker volume rm tldx-x >/dev/null 2>&1`, 'no juzgo la linea entera');
        /* la mitad ya tecleada se cancelo: la siguiente linea sale limpia */
        await svc.call('send_input', { session_id: sid, data: 'echo limpio-$((3*7))\r' });
        const seen = await read(/limpio-21/);
        assert.match(seen, /limpio-21/);
        await sleep(300);
        assert.ok(!fs.existsSync(marker), 'la linea bloqueada se ejecuto');
        /* heredoc hacia psql en varias llamadas: se juzga al cerrarse */
        n = asks.length;
        await svc.call('send_input', { session_id: sid, data: 'cat <<EOF | psql\r' });
        await svc.call('send_input', { session_id: sid, data: 'DROP TABLE x;\r' });
        assert.strictEqual(asks.length, n, 'pregunto antes de cerrar el heredoc');
        await assert.rejects(svc.call('send_input', { session_id: sid, data: 'EOF\r' }), /database drop or wipe/);
        /* lineas tecleadas en un prompt de base de datos */
        await assert.rejects(svc.call('send_input', { session_id: sid, data: 'DROP DATABASE ventas;\n' }), /Blocked/);
        await svc.call('send_input', { session_id: sid, data: 'DELETE FROM users WHERE\n' });
        await assert.rejects(svc.call('send_input', { session_id: sid, data: 'true;\n' }), /Blocked/);
        /* aprobada: se escribe y se ejecuta */
        answer = { approved: true, reason: 'approved' };
        await svc.call('send_input', { session_id: sid, data: `${cmd}\r` });
        await read(/ejecutado/);
        assert.ok(await until(() => fs.existsSync(marker), 3000), 'la aprobada no se ejecuto');
        await svc.log.flush();
        const log = await svc.log.list();
        assert.ok(log.some(e => e.tool === 'send_input (blocked)' && e.category === 'data-volumes'));
        assert.ok(log.some(e => e.tool === 'send_input (approved)' && e.category === 'data-volumes'));
      } finally {
        await svc.call('close_shell', { session_id: sid }).catch(() => {});
      }
    });
  } finally {
    await svc.stop().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }

  await check('DX11 la regla llega a los agentes: instructions, run_command/send_input, guia y docs/agents.md', () => {
    const mcp = require(path.join(ROOT, 'electron', 'agent', 'mcp.js'));
    const { GUIDE } = require(path.join(ROOT, 'electron', 'agent', 'guide.js'));
    assert.match(mcp.INSTRUCTIONS, /Destructive commands need the user's approval/);
    assert.match(mcp.INSTRUCTIONS, /do not retry/);
    for (const n of ['run_command', 'send_input']) {
      assert.match(mcp.TOOLS.find(t => t.name === n).description, /approve/, `${n} no avisa`);
    }
    assert.match(GUIDE, /## Destructive commands need the user's approval/);
    const doc = fs.readFileSync(path.join(ROOT, 'docs', 'agents.md'), 'utf-8');
    assert.match(doc, /^## Destructive commands need your approval$/m);
    for (const w of ['migrate:fresh', 'dropdb', 'FLUSHALL', 'compose down -v', 'git reset --hard', 'node_modules']) assert.ok(doc.includes(w), `docs sin ${w}`);
    /* La politica sigue en una sola funcion, y el comando pasa por ella */
    const src = fs.readFileSync(path.join(ROOT, 'electron', 'agent', 'agent-service.js'), 'utf-8');
    assert.match(src, /const policy = agentMayUse\(t, \{ tool, command, typed \}\);/);
    assert.match(src, /await this\._authorize\(t, 'run_command', p\.command/);
  });
}

module.exports = { seccionDestructive };
