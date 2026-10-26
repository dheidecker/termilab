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
 *  AT16 regla del cursor sobre pantallas REALES (fixtures/talk): bash con la caja de
 *       un Claude cerrado, cat con firmas, banner de aider, prompt bajo una raya: no;
 *       Claude idle (pantalla normal y alternativa) y Codex idle: si
 *  AT17 /proc (proc-agent.js) con ptys reales: agente en primer plano si, shell o
 *       agente en segundo plano no; AgentTalk rechaza sin escribir si /proc dice no
 *  AT18 saneo: \e[201~, \x03, \e, \r, C1 y "!" al inicio de una linea: un solo
 *       envio, sin secuencias de control; main y renderer dan lo mismo
 *  AT19 cola por destino: dos envios seguidos, cada remitente recibe SU respuesta,
 *       en orden, nunca dos en vuelo; list_sessions dice queued; el tiempo en cola
 *       cuenta para el timeout
 *  AT20 transcript por ref: el mismo texto a dos Claude, cada uno su respuesta
 *  AT21 40 envios en paralelo: pasan exactamente 30
 *  AT22 remitente sin TERMILAB_SESSION_ID: "(unverified)"; nunca a si misma por ppid
 *  AT23 20 wait_reply vencidos dejan 0 waiters
 *  AT24 el fin de entrega solo lo acepta la ventana duena
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
  { windowId: 1, tabId: 'tab-claude2', sessionId: 'pty-6', kind: 'local', connected: true, host: 'Local Terminal', alias: 'cl2', agentId: 'claude', state: 'idle' },
];
const TALK_IDS = { 'pty-0': 'TID-backend', 'pty-1': 'TID-sempat', 'pty-5': 'TID-cl', 'pty-6': 'TID-cl2' };
/* "[Message from … · ref 7f3a9c] x" → "[Message from …] x" */
const noRef = (t) => t.replace(/ · ref [0-9a-f]{6}\]/, ']');
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

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
      ...(opts.deps || {}),
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
      assert.deepStrictEqual(Object.keys(by.sempat).sort(), ['agent', 'alias', 'host', 'queued', 'reachable', 'session', 'state']);
      assert.strictEqual(by.sempat.queued, 0);
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
      assert.deepStrictEqual(win.typed.map(t => noRef(t.text)), [
        '[Message from Termilab session "backend"] ping',
        '[Message from an agent outside Termilab (unverified)] ping',
        '[Message from an agent outside Termilab (unverified)] ping',
      ]);
      /* Cada entrega lleva su ref, distinta */
      const refs = win.typed.map(t => (/ · ref ([0-9a-f]{6})\] ping$/.exec(t.text) || [])[1]);
      assert.ok(refs.every(Boolean) && new Set(refs).size === 3, JSON.stringify(refs));
      /* Sin alias: el nombre corto estable */
      rows = ROWS().map(r => (r.tabId === 'tab-backend' ? { ...r, alias: null } : r));
      try {
        await talk.send({ session: 'sempat', message: 'ping', from: 'TID-backend' });
        const short = talkMod.shortId('tab-backend');
        assert.match(short, /^s[0-9a-f]{5}$/);
        assert.strictEqual(noRef(win.typed[3].text), `[Message from Termilab session "${short}"] ping`);
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
      assert.match(g.result.contents[0].text, /\[Message from Termilab session "<your alias>" · ref <id>\]/);
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
        assert.match(r.stdout, /^pong: \[Message from Termilab session "backend" · ref [0-9a-f]{6}\] ping\n$/);
        const r2 = await cli(['send', 'sempat', 'ping']);
        assert.match(r2.stdout, /^pong: \[Message from an agent outside Termilab \(unverified\) · ref [0-9a-f]{6}\] ping\n$/);
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
      assert.match(tv, /talkType\(\(\) => term\.paste\(typed\)\)/);
      assert.match(tv, /const typed = talkPasteText\(text, !!\(term\.modes && term\.modes\.bracketedPasteMode\)\)/, 'sin bracketed paste: una sola linea');
      assert.match(tv, /const at = talkInputAt\(scr\.rows, scr\.cursorY, a\.id, scr\.cursorX\);\s*if \(!at\.ok\) return \{ ok: false, code: 'not-agent'/, 'la regla del cursor antes de escribir');
      assert.ok(!/talkWatches\.size >= 4/.test(tv), 'el renderer ya no descarta entregas');
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

    /* agentRules.js / agentTalkText.js empaquetados (ESM del renderer) */
    const bundle = (file, name) => {
      const out = path.join(tmp, name);
      execFileSync(path.join(ROOT, 'node_modules', '.bin', 'esbuild'), [
        path.join(ROOT, 'src', 'components', 'Terminal', file),
        '--bundle', '--platform=node', '--format=cjs', `--outfile=${out}`, '--log-level=error',
      ], { stdio: 'pipe' });
      return require(out);
    };

    await check('AT16 regla del cursor sobre pantallas reales: Claude cerrado con la caja, cat con firmas, banner de aider, prompt bajo una raya: no; Claude y Codex idle: si', () => {
      const R = bundle('agentRules.js', 'agent-rules.cjs');
      const dir = path.join(__dirname, 'fixtures', 'talk');
      const load = (n) => JSON.parse(fs.readFileSync(path.join(dir, `${n}.json`), 'utf-8'));
      /* El detector viejo (las ultimas filas) ve un agente en estas pantallas de bash */
      const tailOf = (f) => R.bottomRows(f.rows);
      const judge = (n) => {
        const f = load(n);
        const det = R.detectAgent(tailOf(f), null);
        const id = det ? det.id : null;
        return { det: id, r: R.talkInputAt(f.rows, f.cursorY, id, f.cursorX), f };
      };
      for (const n of ['bash-claude-box-left', 'bash-cat-signatures', 'bash-prompt-under-rule']) {
        const { det, r } = judge(n);
        assert.strictEqual(det, 'claude', `${n}: el detector deberia ver la caja (el falso positivo)`);
        assert.strictEqual(r.ok, false, `${n}: ${JSON.stringify(r)}`);
      }
      const aider = judge('bash-aider-banner');
      assert.strictEqual(aider.det, 'aider', 'el banner viejo de aider se detecta como aider');
      assert.strictEqual(aider.r.ok, false);
      /* Aunque el tracker crea que es Claude o Codex (pegajoso): no */
      for (const n of ['bash-aider-banner', 'bash-claude-box-left', 'bash-cat-signatures', 'bash-after-claude-alt']) {
        const f = load(n);
        for (const id of ['claude', 'codex']) assert.strictEqual(R.talkInputAt(f.rows, f.cursorY, id, f.cursorX).ok, false, `${n} como ${id}`);
      }
      assert.match(judge('bash-claude-box-left').r.reason, /shell prompt/);
      /* Menus de Claude (permiso, pregunta): el cursor esta en "❯ 1." */
      for (const n of ['claude-permission', 'claude-ask']) assert.strictEqual(judge(n).r.ok, false, n);
      /* Agentes de verdad, idle, con el cursor en su campo */
      for (const n of ['claude-idle', 'claude-idle-alt', 'claude-idle-suggestion', 'codex-idle']) {
        const { det, r, f } = judge(n);
        assert.ok(det === 'claude' || det === 'codex', `${n}: ${det}`);
        assert.deepStrictEqual(r, { ok: true }, n);
        /* El cursor una fila mas abajo (debajo de la caja): no */
        assert.strictEqual(R.talkInputAt(f.rows, f.cursorY + 1, det, 0).ok, false, `${n} cursor debajo`);
      }
      assert.strictEqual(load('claude-idle-alt').alt, true, 'Claude 2.1.310 dibuja en la pantalla alternativa');
      /* Lo que esta debajo de la caja tiene que ser el pie del agente (indentado) */
      const f = load('claude-idle');
      const extra = [...f.rows];
      extra[extra.length - 1] = 'derek@pc:~$ ';
      assert.strictEqual(R.talkInputAt(extra, f.cursorY, 'claude', f.cursorX).ok, false);
      /* Otros agentes: todavia sin campo verificado */
      assert.strictEqual(R.talkInputAt(['> '], 0, 'aider', 2).ok, false);
    });

    await check('AT17 /proc: agente vivo en el grupo de primer plano del tty (ptys reales); si no, AgentTalk no escribe', async () => {
      const P = require(path.join(ROOT, 'electron', 'agent', 'proc-agent.js'));
      const inPty = async (cmd) => {
        const s = spawn('script', ['-qfec', cmd, '/dev/null'], { stdio: ['pipe', 'ignore', 'ignore'] });
        let child = null;
        for (let i = 0; i < 60 && !child; i++) {
          await sleep(50);
          try { child = Number(fs.readFileSync(`/proc/${s.pid}/task/${s.pid}/children`, 'utf-8').trim().split(/\s+/)[0]) || null; } catch (_) { child = null; }
        }
        await sleep(250);
        return { s, child, end: () => { try { process.kill(-child, 'SIGKILL'); } catch (_) { /* gone */ } s.kill('SIGKILL'); } };
      };
      const cases = [
        ["bash -c 'exec -a claude sleep 20'", true, 'claude'],                       // el agente es la shell (exec claude)
        ["bash -c '(exec -a codex sleep 20); true'", true, 'codex'],                  // hijo en el mismo grupo
        ["bash -c 'sleep 20; true'", false],                                          // shell con un programa cualquiera
        ["bash -c 'set -m; (exec -a claude sleep 20) & sleep 20'", false],           // agente en SEGUNDO plano: no
      ];
      for (const [cmd, ok, agent] of cases) {
        const p = await inPty(cmd);
        try {
          assert.ok(p.child, `sin hijo de script para ${cmd}`);
          const r = P.foregroundAgent(p.child);
          assert.strictEqual(r.known, true, `${cmd}: ${JSON.stringify(r)}`);
          assert.strictEqual(r.ok, ok, `${cmd}: ${JSON.stringify(r)}`);
          if (agent) assert.strictEqual(r.agent, agent);
          /* pidUnder: el hijo esta bajo script, no al reves */
          assert.strictEqual(P.pidUnder(p.child, p.s.pid), true);
          assert.strictEqual(P.pidUnder(p.s.pid, p.child), false);
        } finally { p.end(); }
      }
      assert.strictEqual(P.foregroundAgent(process.pid).known, false, 'sin tty: no se sabe (la regla del cursor decide)');
      assert.strictEqual(P.agentOf(['cat', 'claude-frame.txt'], 'cat'), null);
      assert.strictEqual(P.agentOf(['vim', 'claude'], 'vim'), null);
      assert.strictEqual(P.agentOf(['node', '/home/u/.npm-global/bin/claude'], 'node'), 'claude');
      assert.strictEqual(P.agentOf(['node', '/x/node_modules/@openai/codex/bin/codex.js'], 'node'), 'codex');
      /* Cableado: /proc dice que en primer plano esta bash → rechazado, nada escrito */
      const asked = [];
      const { talk, win } = make({ deps: { localAgent: async (sid) => { asked.push(sid); return sid === 'pty-1' ? { known: true, ok: false, fg: 'bash' } : { known: false }; } } });
      await rejects(talk.send({ session: 'sempat', message: 'touch /tmp/NO' }), 'not-agent', /foreground program is "bash"/);
      assert.strictEqual(win.typed.length, 0);
      /* No se sabe (keeper sin pid, systemd-run sin MainPID): decide la ventana */
      const ok = await talk.send({ session: 'cl', message: 'hola' });
      assert.strictEqual(ok.sent, true);
      /* SSH: /proc no aplica */
      await talk.send({ session: 'slow', message: 'hola', wait: false });
      assert.deepStrictEqual(asked, ['pty-1', 'pty-5']);
    });

    await check('AT18 saneo: \\e[201~, \\x03, \\e, \\r, C1 y "!" al inicio de una linea → un envio, sin control; main = renderer', async () => {
      const T = bundle('agentTalkText.js', 'talk-text2.cjs');
      const evil = [
        '\x1b[201~\r!touch /tmp/PWNED\r',
        'hola\x03adios',
        'a\x1bb\x1b[31mrojo',
        'uno\rdos\r\ntres',
        'c1\u009b201~\u0085x\u009d0;t\u0007',
        'linea\n!rm -rf ~\n/clear',
        'tab\there\x7f',
      ];
      const { talk, win } = make();
      for (const m of evil) {
        const before = win.typed.length;
        await talk.send({ session: 'sempat', message: m, wait: false });
        assert.strictEqual(win.typed.length, before + 1, `mas de un envio para ${JSON.stringify(m)}`);
        const t = win.typed[win.typed.length - 1].text;
        assert.ok(!CONTROL.test(t), `control en ${JSON.stringify(t)}`);
        assert.ok(t.startsWith('[Message from'), t);
        assert.ok(!t.includes('\x1b') && !t.includes('\r'));
        /* main y renderer sanean igual; el renderer lo repite (idempotente) */
        assert.strictEqual(T.sanitizeTalkText(m), talkMod.sanitizeTalkText(m));
        assert.strictEqual(T.sanitizeTalkText(t), t);
        /* Lo que xterm escribiria al pty: con bracketed paste, UN bloque 200~…201~ y un Enter aparte */
        const bracketed = `\x1b[200~${T.talkPasteText(t, true).replace(/\n/g, '\r')}\x1b[201~`;
        assert.strictEqual(bracketed.split('\x1b[201~').length, 2);
        assert.strictEqual(bracketed.split('\x1b').length, 3);
        /* Sin bracketed paste: una sola linea (ningun \n que haga de Enter) */
        const plain = T.talkPasteText(t, false);
        assert.ok(!/[\n\r]/.test(plain) && plain.startsWith('['), JSON.stringify(plain));
      }
      assert.strictEqual(talkMod.sanitizeTalkText('\x1b[201~\r!touch /tmp/PWNED\r'), '[201~\n!touch /tmp/PWNED\n');
      assert.strictEqual(talkMod.sanitizeTalkText('a\tb'), 'a    b');
      /* El "!" de una linea interna queda dentro del mismo pegado; el texto empieza con "[" */
      assert.match(win.typed[5].text, /^\[Message from .*\] linea\n!rm -rf ~\n\/clear$/);
      /* Solo control: nada que enviar */
      await rejects(talk.send({ session: 'sempat', message: '\x1b\x03\r' }), 'invalid', /no text left/);
    });

    await check('AT19 cola por destino: dos envios seguidos, cada uno SU respuesta, en orden, nunca dos en vuelo; queued; timeout en cola', async () => {
      let inFlight = 0; let maxInFlight = 0; const order = [];
      const { talk } = make({
        onSend: (row, op) => {
          inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
          order.push(op.text.replace(/^\[[^\]]*\] /, ''));
          setTimeout(() => { inFlight--; }, 149);
          return { reply: `pong: ${op.text.replace(/^\[[^\]]*\] /, '')}`, after: 150 };
        },
      });
      const a = talk.send({ session: 'sempat', message: 'uno', from: 'TID-backend' });
      const b = talk.send({ session: 'sempat', message: 'dos', from: 'TID-cl' });
      await sleep(40);
      const mid = talk.listSessions({}).sessions.find(x => x.session === 'sempat');
      assert.strictEqual(mid.queued, 1, 'list_sessions: uno en cola');
      const [ra, rb] = await Promise.all([a, b]);
      assert.deepStrictEqual([ra.reply, rb.reply], ['pong: uno', 'pong: dos']);
      assert.deepStrictEqual(order, ['uno', 'dos']);
      assert.strictEqual(maxInFlight, 1, 'dos entregas en vuelo a la vez');
      assert.ok(rb.waitedMs >= 100, `el segundo espero su turno (${rb.waitedMs} ms)`);
      assert.strictEqual(talk.listSessions({}).sessions.find(x => x.session === 'sempat').queued, 0);
      /* El primero nunca termina: el segundo vence EN COLA, sin escribir nada */
      const { talk: t2, win: w2 } = make({ onSend: () => ({ event: 'never' }) });
      const first = t2.send({ session: 'slow', message: 'largo', timeoutSec: 1.5 });
      await sleep(30);
      const t0 = Date.now();
      await rejects(t2.send({ session: 'slow', message: 'segundo', timeoutSec: 0.3 }), 'timeout', /Nothing was sent/);
      assert.ok(Date.now() - t0 < 1000, 'el tiempo en cola cuenta para el timeout');
      assert.strictEqual(w2.typed.length, 1);
      /* Al vencer el primero, el que viene despues pasa */
      const r1 = await first;
      assert.strictEqual(r1.timedOut, true);
      const third = await t2.send({ session: 'slow', message: 'tercero', wait: false });
      assert.strictEqual(third.sent, true);
      assert.strictEqual(w2.typed.length, 2);
      /* Un error al escribir libera el turno */
      let n = 0;
      const { talk: t3 } = make({ onSend: () => ({ reply: 'ok', after: 10 }) });
      const origPush = t3.deps.push;
      t3.deps.push = (row, op) => (op.kind === 'send' && n++ === 0 ? null : origPush(row, op));
      await rejects(t3.send({ session: 'sempat', message: 'falla' }), 'unreachable');
      const after = await t3.send({ session: 'sempat', message: 'pasa' });
      assert.strictEqual(after.reply, 'ok');
    });

    await check('AT20 transcript por ref: el mismo texto a dos Claude locales, cada uno recibe SU respuesta (HOME falso)', async () => {
      const proj = path.join(home, '.claude', 'projects', '-tmp-dos');
      fs.mkdirSync(proj, { recursive: true });
      const files = { cl: path.join(proj, 'aaaaaaaa-0000-0000-0000-000000000001.jsonl'), cl2: path.join(proj, 'aaaaaaaa-0000-0000-0000-000000000002.jsonl') };
      const ends = {};
      const { talk, win } = make({
        onSend: (row, op) => {
          const lines = [
            { type: 'user', message: { role: 'user', content: op.text } },
            { type: 'assistant', message: { content: [{ type: 'text', text: `respuesta de ${row.alias}` }] } },
          ];
          fs.appendFileSync(files[row.alias], lines.map(l => JSON.stringify(l)).join('\n') + '\n');
          ends[row.alias] = op.deliveryId;
          return { event: 'never' };
        },
      });
      await talk.send({ session: 'cl', message: 'Misma pregunta', from: 'TID-backend', wait: false });
      await talk.send({ session: 'cl2', message: 'Misma pregunta', from: 'TID-backend', wait: false });
      await sleep(30);
      /* El transcript de cl2 es el mas nuevo y tiene el mismo texto: por texto, cl se llevaria el suyo */
      const t = fs.statSync(files.cl2).mtimeMs;
      fs.utimesSync(files.cl, new Date(t - 1000), new Date(t - 1000));
      const wa = talk.waitReply({ session: 'cl', from: 'TID-backend', timeoutSec: 5 });
      const wb = talk.waitReply({ session: 'cl2', from: 'TID-backend', timeoutSec: 5 });
      talk.reply(win.wc, ends.cl, { event: 'done', reply: 'PANTALLA' });
      talk.reply(win.wc, ends.cl2, { event: 'done', reply: 'PANTALLA' });
      const [ra, rb] = await Promise.all([wa, wb]);
      assert.deepStrictEqual([ra.source, ra.reply], ['transcript', 'respuesta de cl']);
      assert.deepStrictEqual([rb.source, rb.reply], ['transcript', 'respuesta de cl2']);
      /* Funcion pura: exige el ref exacto */
      const R = talkMod.replyFromTranscript([
        JSON.stringify({ type: 'user', message: { content: '[Message from x · ref aaaaaa] Q' } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'A' }] } }),
        JSON.stringify({ type: 'user', message: { content: '[Message from x · ref bbbbbb] Q' } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'B' }] } }),
      ], '· ref aaaaaa]');
      assert.deepStrictEqual(R, { found: true, reply: 'A' });
      assert.ok(!fs.existsSync(path.join(os.homedir(), '.claude', 'projects', '-tmp-dos')), 'toco el ~/.claude real');
    });

    await check('AT21 limite de ritmo atomico: 40 envios en paralelo dejan pasar exactamente 30', async () => {
      const { talk, win } = make({ onSend: () => ({ reply: 'ok', after: 1 }) });
      const all = await Promise.allSettled(Array.from({ length: 40 }, (_, i) => talk.send({ session: 'sempat', message: `m${i}`, wait: false })));
      const ok = all.filter(r => r.status === 'fulfilled');
      const rate = all.filter(r => r.status === 'rejected' && r.reason.code === 'rate');
      assert.strictEqual(ok.length, 30, all.filter(r => r.status === 'rejected' && r.reason.code !== 'rate').map(r => r.reason.message).join(' | '));
      assert.strictEqual(rate.length, 10);
      assert.strictEqual(win.typed.length, 30);
    });

    await check('AT22 sin TERMILAB_SESSION_ID: remitente "(unverified)"; nunca a si misma por el ppid del cliente', async () => {
      const seen = [];
      const { talk, win } = make({ deps: { pidInSession: async (sid, pid) => { seen.push([sid, pid]); return sid === 'pty-1' && pid === 4242; } } });
      await rejects(talk.send({ session: 'sempat', message: 'eco' }, { ppid: 4242 }), 'self', /your own session/);
      assert.strictEqual(win.typed.length, 0);
      const r = await talk.send({ session: 'sempat', message: 'hola' }, { ppid: 777 });
      assert.strictEqual(r.sent, true);
      assert.match(win.typed[0].text, /^\[Message from an agent outside Termilab \(unverified\) · ref [0-9a-f]{6}\] hola$/);
      /* SSH: el arbol de procesos remoto no se ve */
      await talk.send({ session: 'slow', message: 'hola', wait: false }, { ppid: 4242 });
      assert.deepStrictEqual(seen, [['pty-1', 4242], ['pty-1', 777]]);
      /* De punta a punta: el cliente manda su process.ppid por el socket */
      const client = fs.readFileSync(path.join(ROOT, 'electron', 'agent', 'client.js'), 'utf-8');
      assert.match(client, /const ppid = process\.ppid;/);
      const svc = fs.readFileSync(path.join(ROOT, 'electron', 'agent', 'agent-service.js'), 'utf-8');
      assert.match(svc, /ppid: Number\.isInteger\(req\.ppid\) && req\.ppid > 1 \? req\.ppid : null/);
      const doc = fs.readFileSync(path.join(ROOT, 'docs', 'agents.md'), 'utf-8');
      assert.match(doc, /The sender's name is informative, not proof/);
    });

    await check('AT23 fuga de waiters: 20 wait_reply vencidos dejan 0', async () => {
      const { talk } = make({ onSend: () => ({ event: 'never' }) });
      await talk.send({ session: 'slow', message: 'nunca termina', wait: false });
      const dlv = talk.last.get('tab-slow');
      for (let i = 0; i < 20; i++) {
        const r = await talk.waitReply({ session: 'slow', timeoutSec: 0.01 });
        assert.strictEqual(r.timedOut, true);
      }
      assert.strictEqual(dlv.waiters.length, 0);
      /* En paralelo tambien */
      await Promise.all(Array.from({ length: 20 }, () => talk.waitReply({ session: 'slow', timeoutSec: 0.02 })));
      assert.strictEqual(dlv.waiters.length, 0);
    });

    await check('AT24 el fin de una entrega solo lo acepta la ventana duena', async () => {
      let id = null;
      const { talk, win } = make({ onSend: (row, op) => { id = op.deliveryId; return { event: 'never' }; } });
      await talk.send({ session: 'sempat', message: 'hola', wait: false });
      assert.strictEqual(talk.reply({ id: 'otra-ventana' }, id, { event: 'done', reply: 'FALSO' }), false);
      assert.strictEqual(talk.last.get('tab-sempat').result, null);
      assert.strictEqual(talk.reply(win.wc, id, { event: 'done', reply: 'de verdad' }), true);
      const r = await talk.waitReply({ session: 'sempat', timeoutSec: 2 });
      assert.strictEqual(r.reply, 'de verdad');
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
