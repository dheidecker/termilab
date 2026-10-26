#!/usr/bin/env node
// Agente falso para scripts/e2e-agent-talk.mjs: imita lo que agentRules.js
// reconoce de Claude Code (la caja de entrada entre dos reglas con "❯", el
// "? for shortcuts" y el spinner "✻ Thinking… (esc to interrupt)") y lo que
// TerminalView toma como fin de turno (BEL). Pide bracketed paste (?2004h),
// junta lo pegado entre \e[200~ y \e[201~, y con Enter: borra su caja, hace
// eco "> <texto>", trabaja 1,5 s con el spinner, responde "● pong: <texto>",
// vuelve a dibujar la caja y suena el BEL. Cada mensaje recibido se agrega a
// FAKE_AGENT_LOG (si existe) para que la prueba vea los bytes exactos.
import fs from 'node:fs';

const out = (s) => process.stdout.write(s);
const cols = () => Math.max(40, (process.stdout.columns || 100) - 1);
const rule = () => '─'.repeat(cols());
const LOG = process.env.FAKE_AGENT_LOG || '';

/* The box: rule, prompt (cursor here), rule, hint. Cursor back on the prompt. */
function box(input = '') {
  out(`${rule()}\r\n❯ ${input}\r\n${rule()}\r\n  ? for shortcuts`);
  out(`\x1b[2A\r\x1b[${3 + [...input].length}G`);
}

process.stdin.setRawMode(true);
process.stdin.setEncoding('utf-8');
out('\x1b[?2004h');
out('Claude Code v9.9.9 (fake agent for the agent-talk e2e)\r\n\r\n');
box();

let input = '';
let pasting = false;
let busy = false;
let pending = '';

function submit() {
  const text = input;
  input = '';
  if (!text.trim()) return;
  if (LOG) fs.appendFileSync(LOG, `${JSON.stringify(text)}\n`);
  busy = true;
  /* From the rule above the prompt down: the echo replaces the box */
  out('\x1b[1A\r\x1b[J');
  out(`> ${text.replace(/\n/g, '\r\n  ')}\r\n\r\n`);
  out('✻ Thinking… (esc to interrupt)\r\n\r\n');
  box();
  setTimeout(() => {
    out('\x1b[3A\r\x1b[J');
    out(`● pong: ${text.replace(/\n/g, '\r\n  ')}\r\n\r\n✻ Baked for 1s\r\n\r\n`);
    box();
    out('\x07');
    busy = false;
  }, 1500);
}

process.stdin.on('data', (d) => {
  pending += d;
  for (;;) {
    if (!pending) return;
    if (pending.startsWith('\x1b[200~')) { pasting = true; pending = pending.slice(6); continue; }
    if (pending.startsWith('\x1b[201~')) { pasting = false; pending = pending.slice(6); out(`\r\x1b[2K❯ ${input.split('\n')[0]}`); continue; }
    if (pending[0] === '\x1b' && pending.length < 6 && '\x1b[20'.startsWith(pending.slice(0, 4))) return;   // a marker cut in two
    const c = pending[0];
    pending = pending.slice(1);
    if (pasting) { input += c === '\r' ? '\n' : c; continue; }
    if (c === '\x03') { out('\x1b[?2004l\r\n'); process.exit(0); }
    if (c === '\r') { if (!busy) submit(); continue; }
    if (c === '\x7f') { input = input.slice(0, -1); continue; }
    if (c >= ' ') { input += c; out(c); }
  }
});
