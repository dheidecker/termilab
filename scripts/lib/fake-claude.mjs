// A stand-in for Claude Code's screen, for scripts/e2e-composer.mjs: it draws
// what Claude Code 2.1.300 draws (copied from the live captures in
// fixtures/prompts/: the input box with a faint suggestion, an AskUserQuestion
// menu, a permission prompt with "Tab to amend") and logs every byte it
// receives, so the test can check exactly which keys the composer sent.
//
//   node fake-claude.mjs <log> <phase-file>
//
// The test switches screens by writing a phase name into <phase-file>:
//   suggest:<text>   idle, empty input box with <text> as the suggestion (SGR 2)
//   idle             idle, empty input box, no suggestion
//   ask              AskUserQuestion: Red / Green / Blue / Type something. / Chat about this
//   perm             Bash permission: Yes / … / No, footer "Esc to cancel · Tab to amend"
//   quit             exit
// Each received chunk is appended to <log> as one JSON string per line.
import fs from 'node:fs';

const [LOG, PHASE] = process.argv.slice(2);
const out = process.stdout;
const ESC = '\x1b';
const DIM = `${ESC}[2m`;
const UNDIM = `${ESC}[22m`;
const NBSP = ' ';

const cols = () => Math.max(40, out.columns || 80);
const rule = () => '─'.repeat(cols());
const header = [' ▐▛███▛█   Claude Code v2.1.300', '▝▜██████▀  Opus 5.5 (1M context) · Claude Team', ' ▝▝   ▝▝   /tmp/fake', ''];

function draw(lines, cursor) {
  let s = `${ESC}[2J${ESC}[H`;
  lines.forEach((l, i) => { s += `${ESC}[${i + 1};1H${l}`; });
  if (cursor) s += `${ESC}[${cursor[0]};${cursor[1]}H`;
  out.write(s);
}

function screen(phase) {
  if (phase.startsWith('suggest:') || phase === 'idle') {
    const sug = phase.startsWith('suggest:') ? phase.slice(8) : '';
    const lines = [...header, '● Done.', '', rule(), `❯${NBSP}${sug ? `${DIM}${sug}${UNDIM}` : ''}`, rule(), '  ⏸ manual mode on · ← for agents'];
    draw(lines, [header.length + 4, 3]);
    return;
  }
  if (phase === 'ask') {
    draw([...header, rule(), ' ☐ Colour ', '', 'Which colour do you prefer?', '',
      '❯ 1. Red', '     The colour red.', '  2. Green', '     The colour green.', '  3. Blue', '     The colour blue.',
      '  4. Type something.', rule(), '  5. Chat about this', '', 'Enter to select · ↑/↓ to navigate · Esc to cancel']);
    return;
  }
  if (phase === 'perm') {
    draw([...header, rule(), ' Bash command', '', ' touch a.txt', '', ' Do you want to proceed?',
      ' ❯ 1. Yes', '   2. Yes, and always allow access to /tmp/fake from this project',
      '   3. Yes, and switch to auto mode', '   4. No', '', ' Esc to cancel · Tab to amend']);
  }
}

let phase = '';
const poll = () => {
  let next = '';
  try { next = fs.readFileSync(PHASE, 'utf8').trim(); } catch (_) { return; }
  if (next === phase) return;
  phase = next;
  if (phase === 'quit') { out.write(`${ESC}[?2004l${ESC}[2J${ESC}[H`); process.exit(0); }
  screen(phase);
};

process.stdin.setRawMode(true);
process.stdin.on('data', (d) => fs.appendFileSync(LOG, JSON.stringify(d.toString('utf8')) + '\n'));
out.write(`${ESC}[?2004h`);   // bracketed paste on, as Claude Code does
fs.writeFileSync(LOG, '');
setInterval(poll, 80);
out.on('resize', () => screen(phase));
poll();
