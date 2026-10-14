/**
 * Seccion PA del arnes del main (scripts/check-main.js): respuestas rapidas a
 * un aviso de agente (Agents/PromptActions.jsx), con parseChoices() de
 * src/components/Terminal/agentRules.js empaquetado con esbuild.
 *
 * Las pantallas de scripts/lib/fixtures/prompts/ son capturas REALES (pty +
 * @xterm/headless, 2026-10-14): Claude Code 2.1.299 y Codex 0.162.1; las
 * old-* son de Claude 2.1.287 / Codex 0.128.0 (2026-10-02). codex-hooks-review
 * se copio a mano del volcado de esa pantalla (se piso el archivo).
 *
 *  PA1  Claude, aviso de permiso: 4 opciones + Cancel, se contesta con el digito.
 *  PA2  Claude, aviso de confianza (sin numeros): flechas desde el cursor + Enter.
 *  PA3  Codex, aprobacion: digitos (verificado en vivo), sin el "(y)" en la etiqueta.
 *  PA4  Codex, revision de hooks al arrancar: "enter confirm · esc skip".
 *  PA5  Pregunta de shell en la fila del cursor: [Y/n], (yes/no/[fingerprint]), Aider.
 *  PA6  Pantallas que NO son un aviso (lista numerada en la conversacion, idle,
 *       trabajando, la lista de hooks, bash tras un echo '[Y/n]'...) → nada.
 *  PA7  Pregunta de shell que no esta en la fila del cursor → nada.
 *  PA8  Un agente sin digitos verificados recibe flechas, no digitos.
 *  PA9  detectAgent sobre las capturas nuevas (Codex 0.162 no se confunde con Claude).
 *  PA10 TerminalView manda las teclas sin broadcast y solo con el agente bloqueado.
 *
 * Solo esta seccion: TERMILAB_CHECK_ONLY=PA, o `node scripts/lib/check-prompt-actions.js`.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const FIX = path.join(__dirname, 'fixtures', 'prompts');
const screen = (name) => fs.readFileSync(path.join(FIX, `${name}.txt`), 'utf-8').split('\n');

async function seccionPromptActions({ check, ROOT }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termilab-pa-'));
  const out = path.join(tmp, 'rules.cjs');
  execFileSync(path.join(ROOT, 'node_modules', '.bin', 'esbuild'), [
    path.join(ROOT, 'src', 'components', 'Terminal', 'agentRules.js'),
    '--bundle', '--platform=node', '--format=cjs', `--outfile=${out}`, '--log-level=error',
  ], { stdio: 'pipe' });
  const R = require(out);
  /* As TerminalView reads it: the bottom rows, the agent there */
  const parse = (name, agentId, opts) => R.parseChoices(R.bottomRows(screen(name)), agentId, opts);
  const summary = (list) => list.map(c => [c.label, c.keys]);
  const lastText = (lines) => R.bottomRows(lines).slice(-1)[0];

  try {
    await check('PA1 Claude, aviso de permiso (2.1.299 y 2.1.287): digitos 1-4 y Esc', () => {
      for (const name of ['claude-permission', 'old-claude-permission']) {
        const got = summary(parse(name, 'claude'));
        assert.strictEqual(got.length, 5, `${name}: ${JSON.stringify(got)}`);
        assert.deepStrictEqual(got.map(g => g[1]), ['1', '2', '3', '4', '\x1b'], name);
        assert.strictEqual(got[0][0], 'Yes');
        assert.match(got[1][0], /^Yes, and always allow access to/);
        assert.strictEqual(got[2][0], 'Yes, and switch to auto mode', 'la cola " · auto mode handles..." se corta');
        assert.strictEqual(got[3][0], 'No');
        assert.strictEqual(got[4][0], 'Cancel');
      }
      const c = parse('claude-permission', 'claude');
      assert.deepStrictEqual(c.map(x => x.hint), ['1', '2', '3', '4', 'Esc']);
      assert.ok(c[4].cancel && !c[3].cancel);
    });

    await check('PA2 Claude, aviso de confianza: sin digitos, flechas desde "No, exit" + Enter', () => {
      for (const name of ['claude-trust', 'old-claude-trust']) {
        assert.deepStrictEqual(summary(parse(name, 'claude')), [
          ['No, exit', '\r'],
          ['Yes, I trust this folder', '\x1b[B\r'],
          ['Cancel', '\x1b'],
        ], name);
      }
    });

    await check('PA3 Codex, aprobacion (0.162.1 y 0.128.0): digitos, etiqueta sin "(y)"', () => {
      for (const name of ['codex-approval', 'old-codex-approval']) {
        const got = summary(parse(name, 'codex'));
        assert.deepStrictEqual(got.map(g => g[1]), ['1', '2', '3', '\x1b'], `${name}: ${JSON.stringify(got)}`);
        assert.strictEqual(got[0][0], 'Yes, proceed');
        assert.match(got[1][0], /^Yes, and don't ask again for commands that start with `touch c\.txt`$/);
        assert.strictEqual(got[2][0], 'No, and tell Codex what to do differently');
      }
    });

    await check('PA4 Codex, revision de hooks al arrancar: 3 opciones + Esc (skip)', () => {
      assert.deepStrictEqual(summary(parse('codex-hooks-review', 'codex')), [
        ['Review hooks', '1'], ['Trust all and continue', '2'],
        ["Continue without trusting (hooks won't run)", '3'], ['Cancel', '\x1b'],
      ]);
    });

    await check('PA5 pregunta de shell en la fila del cursor: [Y/n], (yes/no/[fingerprint]), Aider', () => {
      const yn = screen('bash-yn');
      const yes = R.parseChoices(R.bottomRows(yn), null, { cursorLine: lastText(yn) + ' ' });
      assert.deepStrictEqual(summary(yes), [['Yes', 'y\r'], ['No', 'n\r']]);
      assert.deepStrictEqual(yes.map(c => !!c.default), [true, false], 'la Y mayuscula es la opcion por defecto');
      const yesno = screen('bash-yesno');
      assert.deepStrictEqual(summary(R.parseChoices(R.bottomRows(yesno), null, { cursorLine: lastText(yesno) })),
        [['Yes', 'yes\r'], ['No', 'no\r']]);
      assert.deepStrictEqual(summary(R.parseChoices(['Remove foo.txt? [y/N] '], null)), [['Yes', 'y\r'], ['No', 'n\r']]);
      assert.deepStrictEqual(R.parseChoices(['Remove foo.txt? [y/N] '], null).map(c => !!c.default), [false, true]);
      assert.deepStrictEqual(summary(R.parseChoices(['Overwrite? (y/n)'], null)), [['Yes', 'y\r'], ['No', 'n\r']]);
      const aider = R.parseChoices(['Add file to the chat? (Y)es/(N)o/(D)on\'t ask again [Yes]: '], 'aider');
      assert.deepStrictEqual(summary(aider), [['Yes', 'y\r'], ['No', 'n\r']]);
      assert.ok(aider[0].default);
    });

    await check('PA6 pantallas que no son un aviso no dan botones', () => {
      const none = ['claude-after-trust', 'claude-permission-after-digit', 'old-claude-idle-after-turn',
        'old-claude-working-tool', 'codex-idle', 'codex-hooks-list', 'codex-approval-after-digit',
        'old-codex-working', 'old-bash', 'bash-yn-after', 'bash-yesno-after'];
      for (const name of none) {
        const lines = screen(name);
        for (const agent of [null, 'claude', 'codex']) {
          const got = R.parseChoices(R.bottomRows(lines), agent, { cursorLine: lastText(lines) });
          assert.deepStrictEqual(got, [], `${name} (${agent}): ${JSON.stringify(summary(got))}`);
        }
      }
      /* Not even the full screen (more rows than the scan reads) */
      assert.deepStrictEqual(R.parseChoices(screen('claude-permission-after-digit'), 'claude'), []);
      assert.deepStrictEqual(R.parseChoices([], 'claude'), []);
      assert.deepStrictEqual(R.parseChoices(null, 'claude'), []);
      /* A numbered list with a cursor but a gap in its numbers, or no footer */
      assert.deepStrictEqual(R.parseChoices([' ❯ 1. Yes', '   3. No', ' Esc to cancel'], 'claude'), []);
      assert.deepStrictEqual(R.parseChoices([' ❯ 1. Yes', '   2. No'], 'claude'), []);
    });

    await check('PA7 la pregunta de shell tiene que estar en la fila del cursor', () => {
      const yn = screen('bash-yn');
      assert.deepStrictEqual(R.parseChoices(R.bottomRows(yn), null, { cursorLine: '' }), [],
        'echo \'[Y/n]\' con el cursor en otra fila (un programa que sigue) no es una pregunta');
    });

    await check('PA8 agente sin digitos verificados: flechas desde el cursor + Enter', () => {
      assert.deepStrictEqual(parse('claude-permission', 'gemini').map(c => c.keys),
        ['\r', '\x1b[B\r', '\x1b[B\x1b[B\r', '\x1b[B\x1b[B\x1b[B\r', '\x1b']);
      const up = R.parseChoices(['   1. Allow once', '   2. Allow always', ' ● 3. Deny', ' Esc to cancel'], 'gemini');
      assert.deepStrictEqual(up.map(c => c.keys), ['\x1b[A\x1b[A\r', '\x1b[A\r', '\r', '\x1b']);
      assert.ok(up.every(c => c.cancel || c.hint === null), 'sin digitos no se ensena atajo');
    });

    await check('PA9 detectAgent sobre las capturas nuevas', () => {
      const st = (name, prev = null) => { const r = R.detectAgent(R.bottomRows(screen(name)), prev); return r && `${r.id}:${r.state}`; };
      assert.strictEqual(st('claude-permission'), 'claude:blocked');
      assert.strictEqual(st('claude-trust'), 'claude:blocked');
      assert.strictEqual(st('claude-after-trust'), 'claude:idle');
      assert.strictEqual(st('claude-permission-after-digit'), 'claude:idle');
      assert.strictEqual(st('codex-approval'), 'codex:blocked');
      assert.strictEqual(st('codex-idle'), 'codex:idle', 'Codex 0.162 ("? for shortcuts", "GPT-6.1-Sol") no es Claude');
      assert.strictEqual(st('codex-approval-after-digit'), 'codex:idle');
      assert.strictEqual(st('codex-hooks-review'), 'codex:blocked');
      assert.strictEqual(st('old-bash'), null);
    });

    await check('PA10 TerminalView: teclas sin broadcast, menu solo bloqueado, notificacion enfoca el panel', () => {
      const tv = fs.readFileSync(path.join(ROOT, 'src', 'components', 'Terminal', 'TerminalView.jsx'), 'utf-8');
      const answer = tv.match(/const answerPrompt = \(choice\) => \{[\s\S]*?\n  \};/);
      assert.ok(answer, 'falta answerPrompt');
      assert.match(answer[0], /noBroadcastRef\.current = true;[\s\S]*t\.input\(choice\.keys, true\)[\s\S]*finally \{ noBroadcastRef\.current = false;/);
      assert.match(tv, /a\.state === 'blocked' \? parseChoices\(/);
      assert.match(tv, /<PromptActions choices=\{choices\} onAnswer=\{answerPrompt\} \/>/);
      assert.strictEqual((tv.match(/\.onclick = showThisPane/g) || []).length, 2, 'las dos notificaciones tienen que abrir su panel');
      /* onData de ssh y de local: las dos ramas de broadcast miran la bandera */
      assert.strictEqual((tv.match(/broadcastRef\.current && !noBroadcastRef\.current/g) || []).length, 2);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { seccionPromptActions };

if (require.main === module) {
  let failures = 0;
  const check = (name, fn) => Promise.resolve().then(fn)
    .then(() => console.log(`  ok   ${name}`))
    .catch((e) => { failures++; console.log(`  FALLA ${name}\n         ${e && e.message}`); });
  seccionPromptActions({ check, ROOT: path.join(__dirname, '..', '..') })
    .then(() => { console.log(failures ? `\n${failures} fallidas` : '\nTodo en verde (PA)'); process.exit(failures ? 1 : 0); });
}
