/**
 * Seccion AT del arnes del main (scripts/check-main.js): un agente le habla a
 * otro por su sesion de Termilab (electron/agent/agent-talk.js).
 *
 * Main de verdad (AgentTalk, AgentService con su socket, AgentLog en disco,
 * termilab-cli por el socket); el renderer es FALSO: un push() que contesta
 * como contestaria la ventana duena (TerminalView: send / read / fin de
 * turno). La extraccion de la respuesta desde la pantalla
 * (src/components/Terminal/agentTalkText.js) va empaquetada con esbuild.
 * HOME falso para el transcript de Claude: nunca se lee ~/.claude real.
 *
 *  AT1  resolucion por alias: exacto, sin mayusculas, ambiguo, inexistente
 *  AT2  shell sin agente: rechazada, nada escrito
 *  AT3  esperando permiso: rechazada sin escribir
 *  AT4  prefijo de remitente: con TERMILAB_SESSION_ID (alias del emisor) y sin el
 *  AT5  topes: 8000 caracteres y 30 mensajes por hora por destino
 *  AT6  sesion bloqueada por el usuario y sesion en Background: rechazadas
 *  AT7  a si misma: rechazado
 *  AT8  fin de turno: devuelve la respuesta (pantalla), ocupada = queued
 *  AT9  timeout: timedOut + lo que hay; wait_reply sigue esperando
 *  AT10 Claude local: la respuesta sale del transcript (HOME falso)
 *  AT11 log: de, a, largo y resultado; nunca el texto completo de uno largo
 *  AT12 tools/list de ambos protocolos trae las tools nuevas
 *  AT13 extraccion desde la pantalla (Claude, Codex, eco re-envuelto, pegado colapsado)
 *  AT14 socket + termilab-cli: TERMILAB_SESSION_ID llega como remitente; sessions/send
 *  AT15 renderer: TerminalView escribe como el Composer y el BEL tras el pegado no es queja
 *
 * Solo esta seccion: TERMILAB_CHECK_ONLY=AT node scripts/check-main.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const ROWS = () => [
  { windowId: 1, tabId: 'tab-backend', sessionId: 'pty-0', kind: 'local', connected: true, host: 'Local Terminal', alias: 'backend', agentId: 'claude', state: 'idle' },
  { windowId: 1, tabId: 'tab-sempat', sessionId: 'pty-1', kind: 'local', connected: true, host: 'Local Terminal', alias: 'sempat', agentId: 'codex', state: 'idle' },
  { windowId: 1, tabId: 'tab-shell', sessionId: 'pty-2', kind: 'local', connected: true, host: 'Local Terminal', alias: 'shell', agentId: null, state: null },
  { windowId: 1, tabId: 'tab-perm', sessionId: 'pty-3', kind: 'local', connected: true, host: 'Local Terminal', alias: 'perm', agentId: 'claude', state: 'blocked' },
  { windowId: 1, tabId: 'tab-locked', sessionId: 'pty-4', kind: 'local', connected: true, host: 'Local Terminal', alias: 'locked', agentId: 'claude', state: 'idle', talkBlocked: true },
  { windowId: 2, tabId: 'tab-dup1', sessionId: 'ssh-1', kind: 'ssh', connected: true, host: 'web', alias: 'dup', agentId: 'claude', state: 'idle' },
  { windowId: 2, tabId: 'tab-dup2', sessionId: 'ssh-2', kind: 'ssh', connected: true, host: 'db', alias: 'DUP', agentId: 'claude', state: 'idle' },
  { windowId: 2, tabId: 'tab-busy', sessionId: 'ssh-3', kind: 'ssh', connected: true, host: 'web', alias: 'busy', agentId: 'claude', state: 'working' },
  { windowId: 2, tabId: 'tab-slow', sessionId: 'ssh-4', kind: 'ssh', connected: true, host: 'web', alias: 'slow', agentId: 'codex', state: 'idle' },
  { windowId: 1, tabId: 'tab-claude', sessionId: 'pty-5', kind: 'local', connected: true, host: 'Local Terminal', alias: 'cl', agentId: 'claude', state: 'idle' },
];
const TALK_IDS = { 'pty-0': 'TID-backend', 'pty-1': 'TID-sempat', 'pty-5': 'TID-cl' };

/**
 * A fake owner window. behaviour per alias:
 *   reply(text) -> {screen, after}   'never' = the turn never ends
 */
function fakeWindows(talk, { onSend } = {}) {
  const typed = [];
  const wc = { id: 'fake-window' };
  const push = (row, op) => {
    setTimeout(() => {
      if (op.kind === 'send') {
        typed.push({ alias: row.alias, text: op.text });
        talk.reply(wc, op.opId, { ok: true, state: row.state });
        const plan = onSend ? onSend(row, op) : { reply: `pong: ${op.text}`, after: 20 };
        if (plan && plan.event !== 'never') {
          setTimeout(() => talk.reply(wc, op.deliveryId, { event: plan.event || 'done', reply: plan.reply, truncated: false }), plan.after || 20);
        }
      } else if (op.kind === 'read') {
        talk.reply(wc, op.opId, { reply: 'partial answer so far', state: 'working' });
      } else {
        talk.reply(wc, op.opId, { ok: true });
      }
    }, 5);
    return wc;
  };
  return { typed, push, wc };
}

async function seccionAgentTalk({ check, ROOT }) {
  const talkMod = require(path.join(ROOT, 'electron', 'agent', 'agent-talk.js'));
  const { AgentLog } = require(path.join(ROOT, 'electron', 'agent', 'agent-log.js'));
  const { AgentService } = require(path.join(ROOT, 'electron', 'agent', 'agent-service.js'));
  const mcp = require(path.join(ROOT, 'electron', 'agent', 'mcp.js'));

  const tmp = fs.mkdtempSync('/tmp/tlat-');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  const log = new AgentLog(() => path.join(tmp, 'data'));
  let rows = ROWS();
  let background = [{ keeperId: 'aaaaaaaaaaaaaaaaaaaaaaaa', kind: 'local', label: 'Local Terminal', alias: 'bgone', agent: { id: 'claude', name: 'Claude Code' } }];

  const make = (opts = {}) => {
    const talk = new talkMod.AgentTalk();
    const win = fakeWindows(talk, opts);
    talk.configure({
      rows: () => rows,
      background: () => background,
      talkIdOf: (sid) => TALK_IDS[sid] || null,
      push: win.push,
      home: () => home,
      log,
    });
    return { talk, win };
  };
  const rejects = async (p, code, re) => {
    let err = null;
    try { await p; } catch (e) { err = e; }
    assert.ok(err, `no fallo (se esperaba ${code})`);
    if (code) assert.strictEqual(err.code, code, `${err.code}: ${err.message}`);
    if (re) assert.match(err.message, re);
    return err;
  };

  try {
    await check('AT1 resolucion por alias: exacto, sin mayusculas, ambiguo (con opciones), inexistente (con la lista)', async () => {
      const { talk, win } = make();
      const a = await talk.send({ session: 'sempat', message: 'hola' });
      assert.strictEqual(a.session, 'sempat');
      const b = await talk.send({ session: 'SeMpAt', message: 'hola' });
      assert.strictEqual(b.session, 'sempat');
      assert.strictEqual(win.typed.length, 2);
      const amb = await rejects(talk.send({ session: 'Dup', message: 'x' }), 'ambiguous', /matches 2 sessions/);
      assert.match(amb.message, /"dup" \(web, claude\)/);
      assert.match(amb.message, /"DUP" \(db, claude\)/);
      const none = await rejects(talk.send({ session: 'nadie', message: 'x' }), 'not-found', /No session named "nadie"/);
      assert.match(none.message, /"sempat"/);
      assert.match(none.message, /"backend"/);
      assert.strictEqual(win.typed.length, 2, 'algo se escribio en un error');
      /* list_sessions: forma y "reachable" */
      const { sessions } = talk.listSessions({ from: 'TID-backend' });
      const by = Object.fromEntries(sessions.map(s => [s.session, s]));
      assert.deepStrictEqual(Object.keys(by.sempat).sort(), ['agent', 'alias', 'host', 'reachable', 'session', 'state']);
      assert.deepStrictEqual([by.sempat.agent, by.sempat.state, by.sempat.reachable, by.sempat.host], ['codex', 'idle', true, 'local']);
      assert.deepStrictEqual([by.shell.agent, by.shell.reachable], [null, false]);
      assert.deepStrictEqual([by.perm.state, by.busy.state], ['waiting-permission', 'working']);
      assert.strictEqual(by.locked.reachable, false);
      assert.strictEqual(by.bgone.reachable, false);
      assert.strictEqual(by.backend.self, true);
      assert.ok(!('self' in by.sempat));
    });

    await check('AT2 una shell sin agente detectado: rechazada, nada escrito', async () => {
      const { talk, win } = make();
      await rejects(talk.send({ session: 'shell', message: 'rm -rf ~' }), 'not-agent', /plain shell/);
      assert.strictEqual(win.typed.length, 0);
    });

    await check('AT3 esperando permiso o una pregunta: rechazada sin escribir', async () => {
      const { talk, win } = make();
      await rejects(talk.send({ session: 'perm', message: 'hola' }), 'busy', /waiting for the user.*Nothing was sent/);
      assert.strictEqual(win.typed.length, 0);
    });

    await check('AT4 prefijo de remitente: con TERMILAB_SESSION_ID (su alias) y sin el ("an agent outside Termilab")', async () => {
      const { talk, win } = make();
      await talk.send({ session: 'sempat', message: 'ping', from: 'TID-backend' });
      await talk.send({ session: 'sempat', message: 'ping', from: null });
      await talk.send({ session: 'sempat', message: 'ping', from: 'TID-desconocido' });
      assert.deepStrictEqual(win.typed.map(t => t.text), [
        '[Message from Termilab session "backend"] ping',
        '[Message from an agent outside Termilab] ping',
        '[Message from an agent outside Termilab] ping',
      ]);
      /* Sin alias: el nombre corto estable */
      rows = ROWS().map(r => (r.tabId === 'tab-backend' ? { ...r, alias: null } : r));
      try {
        await talk.send({ session: 'sempat', message: 'ping', from: 'TID-backend' });
        const short = talkMod.shortId('tab-backend');
        assert.match(short, /^s[0-9a-f]{5}$/);
        assert.strictEqual(win.typed[3].text, `[Message from Termilab session "${short}"] ping`);
      } finally { rows = ROWS(); }
    });

    await check('AT5 topes: mas de 8000 caracteres rechazado; 30 por hora por destino, el 31 no', async () => {
      const { talk, win } = make();
      await rejects(talk.send({ session: 'sempat', message: 'x'.repeat(8001) }), 'invalid', /8001 characters; the limit is 8000/);
      assert.strictEqual(win.typed.length, 0);
      const ok = await talk.send({ session: 'sempat', message: 'y'.repeat(8000), wait: false });
      assert.strictEqual(ok.sent, true);
      for (let i = 1; i < 30; i++) await talk.send({ session: 'sempat', message: `n${i}`, wait: false });
      await rejects(talk.send({ session: 'sempat', message: 'uno mas' }), 'rate', /30 messages from agents in the last hour/);
      assert.strictEqual(win.typed.length, 30);
      /* El tope es por destino: otro destino sigue abierto */
      const other = await talk.send({ session: 'slow', message: 'hola', wait: false });
      assert.strictEqual(other.sent, true);
    });

    await check('AT6 sesion bloqueada por el usuario y sesion en Background: rechazadas, nada escrito', async () => {
      const { talk, win } = make();
      await rejects(talk.send({ session: 'locked', message: 'hola' }), 'blocked', /does not let agents message/);
      await rejects(talk.send({ session: 'bgone', message: 'hola' }), 'unreachable', /background/);
      assert.strictEqual(win.typed.length, 0);
    });

    await check('AT7 enviarse a si misma: rechazado', async () => {
      const { talk, win } = make();
      await rejects(talk.send({ session: 'backend', message: 'eco', from: 'TID-backend' }), 'self', /your own session/);
      assert.strictEqual(win.typed.length, 0);
    });

    await check('AT8 fin de turno: devuelve la respuesta; si estaba ocupada se envia igual (queued)', async () => {
      const { talk } = make({ onSend: (row, op) => ({ reply: `pong: ${op.text.replace(/^\[[^\]]*\] /, '')}`, after: 60 }) });
      const r = await talk.send({ session: 'sempat', message: 'ping', from: 'TID-backend' });
      assert.deepStrictEqual([r.reply, r.state, r.truncated, r.timedOut, r.source, r.queued], ['pong: ping', 'idle', false, false, 'screen', false]);
      const q = await talk.send({ session: 'busy', message: 'ping' });
      assert.strictEqual(q.queued, true);
      assert.match(q.note, /queues the message/);
      assert.strictEqual(q.reply, 'pong: ping');
      /* Se paro a pedir permiso a mitad: state waiting-permission + lo que mostro */
      const { talk: t2 } = make({ onSend: () => ({ event: 'blocked', reply: 'Do you want to proceed?', after: 30 }) });
      const b = await t2.send({ session: 'sempat', message: 'borra build' });
      assert.deepStrictEqual([b.state, b.reply, b.timedOut], ['waiting-permission', 'Do you want to proceed?', false]);
    });

    await check('AT9 timeout: timedOut con lo que hay; wait_reply sigue esperando la misma respuesta', async () => {
      let finish = null;
      const { talk, win } = make({ onSend: (row, op) => { finish = op.deliveryId; return { event: 'never' }; } });
      const t0 = Date.now();
      const r = await talk.send({ session: 'slow', message: 'tarea larga', timeoutSec: 0.3 });
      assert.ok(Date.now() - t0 < 3000);
      assert.deepStrictEqual([r.timedOut, r.reply, r.state], [true, 'partial answer so far', 'working']);
      assert.match(r.note, /wait_reply/);
      const w = talk.waitReply({ session: 'slow', timeoutSec: 5 });
      setTimeout(() => talk.reply(win.wc, finish, { event: 'done', reply: 'listo' }), 100);
      const done = await w;
      assert.deepStrictEqual([done.reply, done.timedOut, done.state], ['listo', false, 'idle']);
      const again = await talk.waitReply({ session: 'slow', timeoutSec: 0 });
      assert.strictEqual(again.reply, 'listo', 'la respuesta ya terminada se devuelve otra vez');
      await rejects(talk.waitReply({ session: 'sempat' }), 'not-found', /Nothing was sent/);
      /* Un push de otra ventana no termina el turno de esta */
      assert.strictEqual(talk.reply({ id: 'otra' }, 'nada', {}), false);
    });

    await check('AT10 Claude local: la respuesta sale del transcript (HOME falso), no de la pantalla', async () => {
      const proj = path.join(home, '.claude', 'projects', '-tmp-proyecto');
      fs.mkdirSync(proj, { recursive: true });
      const file = path.join(proj, '11111111-2222-3333-4444-555555555555.jsonl');
      fs.writeFileSync(file, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'una pregunta vieja' } })}\n`);
      const { talk } = make({
        onSend: (row, op) => {
          const lines = [
            { type: 'user', message: { role: 'user', content: op.text } },
            { type: 'assistant', message: { content: [{ type: 'text', text: 'Reviso la rama.' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'git branch' } }] } },
            { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '* main' }] } },
            { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'SUBAGENTE' }] } },
            { type: 'assistant', message: { content: [{ type: 'text', text: 'Estoy en main.' }] } },
          ];
          fs.appendFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
          return { reply: 'texto de PANTALLA con ruido', after: 30 };
        },
      });
      const r = await talk.send({ session: 'cl', message: 'En que rama estas?', from: 'TID-backend' });
      assert.deepStrictEqual([r.source, r.reply], ['transcript', 'Reviso la rama.\n\nEstoy en main.']);
      /* Codex (sin transcript leido): pantalla */
      const { talk: t2 } = make();
      const c = await t2.send({ session: 'sempat', message: 'hola' });
      assert.strictEqual(c.source, 'screen');
      /* Funcion pura: la ultima pregunta con ese texto, hasta el siguiente prompt */
      const R = talkMod.replyFromTranscript([
        JSON.stringify({ type: 'user', message: { content: 'Q' } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'viejo' }] } }),
        JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'Q' }] } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'nuevo' }] } }),
        JSON.stringify({ type: 'user', message: { content: 'otra cosa' } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'no' }] } }),
      ], 'Q');
      assert.deepStrictEqual(R, { found: true, reply: 'nuevo' });
      assert.ok(!fs.existsSync(path.join(os.homedir(), '.claude', 'projects', '-tmp-proyecto')), 'toco el ~/.claude real');
    });

    await check('AT11 log: cada envio (de, a, largo, resultado); un mensaje largo sin su texto completo', async () => {
      const before = (await log.list()).length;
      const { talk } = make();
      const long = `inicio ${'z'.repeat(3000)} FIN-SECRETO`;
      await talk.send({ session: 'slow', message: long, from: 'TID-backend', wait: false });
      await rejects(talk.send({ session: 'shell', message: 'ls', from: 'TID-backend' }), 'not-agent');
      await log.flush();
      const all = await log.list();
      const mine = all.slice(before).filter(e => e.tool === 'send_to_session');
      assert.strictEqual(mine.length, 2, JSON.stringify(mine));
      const [okE, badE] = mine;
      assert.strictEqual(okE.ok, true);
      assert.strictEqual(okE.host, 'session "slow"');
      assert.match(okE.command, /^from session "backend" \(3019 chars\): inicio z+…$/);
      assert.ok(!okE.command.includes('FIN-SECRETO'), 'el texto completo quedo en el log');
      assert.ok(okE.command.length < 300);
      assert.strictEqual(badE.ok, false);
      assert.match(badE.error, /plain shell/);
      assert.match(badE.command, /^from session "backend" \(2 chars\): ls$/);
    });

    await check('AT12 tools/list (2025-11-25 y 2026-07-28) trae list_sessions, send_to_session y wait_reply', async () => {
      const legacy = await mcp.handle({ id: 1, method: 'tools/list', params: {} });
      const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' };
      const modern = await mcp.handle({ id: 2, method: 'tools/list', params: { _meta: meta } });
      for (const r of [legacy, modern]) {
        const names = r.result.tools.map(t => t.name);
        for (const n of ['list_sessions', 'send_to_session', 'wait_reply']) assert.ok(names.includes(n), `${n} falta`);
      }
      assert.strictEqual(typeof modern.result.ttlMs, 'number');
      assert.strictEqual(modern.result.cacheScope, 'private');
      assert.strictEqual(legacy.result.ttlMs, undefined);
      const send = modern.result.tools.find(t => t.name === 'send_to_session');
      assert.deepStrictEqual(send.inputSchema.required, ['session', 'message']);
      const g = await mcp.handle({ id: 3, method: 'resources/read', params: { uri: 'termilab://guide' } });
      assert.match(g.result.contents[0].text, /send_to_session/);
      assert.match(g.result.contents[0].text, /\[Message from Termilab session "<your alias>"\]/);
    });

    await check('AT13 la respuesta desde la pantalla: sin eco, sin caja de entrada ni spinner (Claude, Codex, eco re-envuelto, pegado colapsado)', () => {
      const out = path.join(tmp, 'talk-text.cjs');
      execFileSync(path.join(ROOT, 'node_modules', '.bin', 'esbuild'), [
        path.join(ROOT, 'src', 'components', 'Terminal', 'agentTalkText.js'),
        '--bundle', '--platform=node', '--format=cjs', `--outfile=${out}`, '--log-level=error',
      ], { stdio: 'pipe' });
      const T = require(out);
      const RULE = '─'.repeat(60);
      const text = '[Message from Termilab session "backend"] ping';
      const claude = ['● algo anterior', '', `> ${text}`, '', '● pong: ping', '  segunda linea', '', '✻ Baked for 2s', '', RULE, '❯ ', RULE, '  ? for shortcuts'];
      assert.deepStrictEqual(T.extractReply(claude, { text, agentId: 'claude' }), { reply: '● pong: ping\n  segunda linea', truncated: false, echoed: true });
      const long = `[Message from Termilab session "backend"] ${'palabra '.repeat(30)}final-del-mensaje`;
      const wrapped = [`> [Message from Termilab session "backend"] ${'palabra '.repeat(12)}`, `  ${'palabra '.repeat(18)}final-del-`, '  mensaje', '', '● ok', '', RULE, '❯ ', RULE];
      assert.strictEqual(T.extractReply(wrapped, { text: long, agentId: 'claude' }).reply, '● ok');
      const codex = [`› ${text}`, '', '• Working (3s • esc to interrupt)', '• respuesta de codex', '', '› Use /skills to list available skills', '', '  gpt-5.5 default · ~/proyecto'];
      assert.strictEqual(T.extractReply(codex, { text, agentId: 'codex' }).reply, '• respuesta de codex');
      const pasted = ['> [Pasted text #1 +40 lines]', '● recibido', RULE, '❯ ', RULE];
      assert.strictEqual(T.extractReply(pasted, { text: `${text}\n${'l\n'.repeat(40)}`, agentId: 'claude' }).reply, '● recibido');
      /* Sin el eco (pantalla limpiada): todo menos la caja */
      assert.deepStrictEqual(T.extractReply(['● solo esto', RULE, '❯ ', RULE], { text, agentId: 'claude' }), { reply: '● solo esto', truncated: false, echoed: false });
      /* Dos mensajes iguales: cuenta el ultimo eco */
      const twice = [`> ${text}`, '● primera', `> ${text}`, '● segunda', RULE, '❯ ', RULE];
      assert.strictEqual(T.extractReply(twice, { text, agentId: 'claude' }).reply, '● segunda');
      /* La respuesta cita el mensaje entero (el agente falso: "pong: <texto>"): el eco es el primero cerca del cursor */
      const quoting = ['● vieja', RULE, `> ${text}`, '', `● pong: ${text}`, '', RULE, '❯ ', RULE];
      assert.strictEqual(T.extractReply(quoting, { text, agentId: 'claude', near: 3 }).reply, `● pong: ${text}`);
      const big = T.extractReply([`> ${text}`, 'x'.repeat(T.TALK_REPLY_MAX + 10)], { text, agentId: null });
      assert.strictEqual(big.truncated, true);
    });

    await check('AT14 socket + termilab-cli: TERMILAB_SESSION_ID llega como remitente; sessions y send', async () => {
      const ud = fs.mkdtempSync('/tmp/tlat-ud-');
      const svc = new AgentService();
      const { talk, win } = make({ onSend: (row, op) => ({ reply: `pong: ${op.text}`, after: 30 }) });
      svc.talk = talk;
      await svc.start({ userDataDir: ud });
      const cli = (args, env = {}) => new Promise((resolve) => {
        const e = { ...process.env, TERMILAB_USER_DATA: ud, ...env };
        if (!('TERMILAB_SESSION_ID' in env)) delete e.TERMILAB_SESSION_ID;
        const c = spawn(process.execPath, [path.join(ROOT, 'electron', 'agent', 'cli.js'), ...args], { env: e });
        let so = ''; let se = '';
        c.stdout.on('data', d => { so += d; }); c.stderr.on('data', d => { se += d; });
        c.on('close', code => resolve({ code, stdout: so, stderr: se }));
      });
      try {
        const s = await cli(['sessions']);
        assert.strictEqual(s.code, 0, s.stderr);
        assert.match(s.stdout, /^SESSION\s+HOST\s+AGENT\s+STATE\s+REACHABLE/);
        assert.match(s.stdout, /sempat\s+local\s+codex\s+idle\s+yes/);
        assert.match(s.stdout, /shell\s+local\s+-\s+unknown\s+no: no agent CLI/);
        const me = await cli(['sessions', '--json'], { TERMILAB_SESSION_ID: 'TID-backend' });
        assert.strictEqual(JSON.parse(me.stdout).sessions.find(x => x.session === 'backend').self, true);
        const r = await cli(['send', 'sempat', 'ping'], { TERMILAB_SESSION_ID: 'TID-backend' });
        assert.strictEqual(r.code, 0, r.stderr);
        assert.strictEqual(r.stdout, 'pong: [Message from Termilab session "backend"] ping\n');
        const r2 = await cli(['send', 'sempat', 'ping']);
        assert.strictEqual(r2.stdout, 'pong: [Message from an agent outside Termilab] ping\n');
        const bad = await cli(['send', 'shell', 'ls']);
        assert.strictEqual(bad.code, 1);
        assert.match(bad.stderr, /plain shell/);
        const self = await cli(['send', 'backend', 'eco'], { TERMILAB_SESSION_ID: 'TID-backend' });
        assert.strictEqual(self.code, 1);
        assert.match(self.stderr, /your own session/);
        const usage = await cli(['send', 'sempat']);
        assert.strictEqual(usage.code, 2);
        assert.strictEqual(win.typed.length, 2);
      } finally {
        await svc.stop();
        fs.rmSync(ud, { recursive: true, force: true });
      }
    });

    await check('AT15 renderer: escribe como el Composer (paste + Enter, sin broadcast), el BEL tras el pegado cuenta, el menu lo bloquea', () => {
      const tv = fs.readFileSync(path.join(ROOT, 'src', 'components', 'Terminal', 'TerminalView.jsx'), 'utf-8');
      assert.match(tv, /term\.onData\(\(\) => \{ if \(!talkInjecting\) lastTyped = Date\.now\(\); \}\)/, 'el pegado del mensaje cuenta como tecleo (el BEL seria queja)');
      assert.match(tv, /talkType\(\(\) => term\.paste\(text\)\)/);
      assert.match(tv, /talkType\(\(\) => term\.input\('\\r', true\)\)/);
      assert.match(tv, /noBroadcastRef\.current = true;\s*bypassRef\.current = true;\s*talkInjecting = true;/);
      assert.match(tv, /a\.state === 'blocked'\) return \{ ok: false, code: 'busy'/);
      const ls = fs.readFileSync(path.join(ROOT, 'electron', 'services', 'local-shell-service.js'), 'utf-8');
      assert.match(ls, /TERMILAB_SESSION_ID: talkId/);
      const dock = fs.readFileSync(path.join(ROOT, 'src', 'components', 'Agents', 'AgentsDock.jsx'), 'utf-8');
      assert.match(dock, /Don't let agents message this session/);
      const gw = fs.readFileSync(path.join(ROOT, 'electron', 'web', 'gateway.js'), 'utf-8');
      assert.ok(!gw.includes('agent-talk'), 'agent-talk no debe estar en la lista blanca web');
      const BG = require(path.join(ROOT, 'electron', 'services', 'background-sessions.js'));
      assert.strictEqual(BG.cleanRecord({ keeperId: 'abcdefgh12345678', kind: 'local', talkBlocked: true }).talkBlocked, true);
      assert.strictEqual(BG.cleanRecord({ keeperId: 'abcdefgh12345678', kind: 'local' }).talkBlocked, false);
    });
  } finally {
    await log.flush();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { seccionAgentTalk };

if (require.main === module) {
  const ROOT = path.join(__dirname, '..', '..');
  let failures = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`  ok   ${name}`); } catch (err) { failures++; console.log(`  FALLA ${name}\n         ${err && err.stack}`); }
  };
  seccionAgentTalk({ check, ROOT }).then(() => {
    console.log(failures ? `\n${failures} comprobacion(es) fallidas` : '\nTodo en verde (AT)');
    process.exit(failures ? 1 : 0);
  });
}
