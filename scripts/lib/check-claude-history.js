/**
 * Seccion CH del arnes del main (scripts/check-main.js): conversaciones de
 * Claude Code en el dock de Sessions (electron/services/claude-history.js).
 * Solo esta seccion: TERMILAB_CHECK_ONLY=CH (~10 s, la mitad es CH6).
 *
 *  CH1  lectura de la cabecera: string / array, meta, sidechain, tool_result,
 *       slash command, titulo, linea malformada, UTF-8 cortado.
 *  CH2  local con HOME falso (con espacios): filas, orden, proyecto con
 *       espacios y comillas, fichero enorme (solo se leen KB), sesion vacia
 *       fuera, carpeta con '-' decodificada contra el disco, tope de 200.
 *  CH3  el script remoto (sh + awk, sin jq/python) corrido aqui con el mismo
 *       HOME da las MISMAS filas que la lectura local.
 *  CH4  sshd de verdad (HOME temporal): por el handler IPC, sobre la MISMA
 *       conexion (ninguna sesion ni cliente nuevo), cache 60 s y fresh.
 *  CH5  salida acotada: arbol que desborda el tope → filas validas, la
 *       ultima cortada se descarta, nunca mas de REMOTE_LIMIT.
 *  CH6  timeout de 5 s respetado (sshd que se duerme) y el error no se cachea.
 *  CH7  comando: comillas para rutas con espacios, ', $(), `; ids y rutas con
 *       control → null; se EJECUTA con sh y un `claude` falso.
 *  CH8  sin ~/.claude/projects: found:false; nada se escribe en disco.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { startRealSshd } = require('./real-sshd');

const SFTP_SERVERS = ['/usr/lib/openssh/sftp-server', '/usr/libexec/openssh/sftp-server', '/usr/lib/ssh/sftp-server', '/usr/libexec/sftp-server'];

const enc = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const J = (o) => JSON.stringify(o);
const uuid = (n) => `${String(n).padStart(8, '0')}-1111-4222-8333-${String(n).padStart(12, '0')}`;

/* A conversation file like Claude Code's */
function convo({ cwd, user, content, title, aiTitle, preface = [], extra = [] }) {
  const lines = [
    J({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-14T10:00:00Z', sessionId: 'x' }),
    ...preface,
  ];
  if (user !== undefined || content !== undefined) {
    lines.push(J({ parentUuid: null, isSidechain: false, promptId: 'p', type: 'user', message: { role: 'user', content: content !== undefined ? content : user }, uuid: 'u1', timestamp: '2026-10-14T10:00:01Z', cwd, sessionId: 'x', version: '2.1.0' }));
  }
  lines.push(J({ parentUuid: 'u1', isSidechain: false, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, cwd }));
  if (title) lines.push(J({ type: 'custom-title', customTitle: title, sessionId: 'x' }));
  if (aiTitle) lines.push(J({ type: 'ai-title', aiTitle, sessionId: 'x' }));
  return `${[...lines, ...extra].join('\n')}\n`;
}

async function seccionClaudeHistory({ check, ROOT, handlers }) {
  const svc = (n) => require(path.join(ROOT, 'electron', 'services', n));
  const ch = svc('claude-history.js');
  const sshService = svc('ssh-service.js');
  const hostKeyService = svc('host-key-service.js');
  const storeService = svc('store-service.js');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termilab-ch-'));
  const home = path.join(tmp, 'home dir');        // espacios en el HOME
  const projects = path.join(home, '.claude', 'projects');
  fs.mkdirSync(projects, { recursive: true });
  const proj = path.join(tmp, 'proj');
  const P = {
    spaces: path.join(proj, 'My Project'),
    quotes: path.join(proj, 'it\'s "q" $(x)'),
    huge: path.join(proj, 'huge'),
    bad: path.join(proj, 'malformed'),
    cmd: path.join(proj, 'cmd'),
    uni: path.join(proj, 'unicode'),
    hyphen: path.join(proj, 'a-b_c'),           // sin cwd: se decodifica contra el disco
    filler: path.join(proj, 'filler'),
  };
  for (const p of Object.values(P)) fs.mkdirSync(p, { recursive: true });

  const t0 = Math.floor(Date.now() / 1000) - 1000;
  const files = {};
  const put = (key, projPath, n, body, ageS) => {
    const dir = path.join(projects, enc(projPath));
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `${uuid(n)}.jsonl`);
    fs.writeFileSync(f, body);
    fs.utimesSync(f, t0 - ageS, t0 - ageS);
    files[key] = { id: uuid(n), file: f, project: projPath, mtime: (t0 - ageS) * 1000 };
  };
  const big = 'x'.repeat(3 * 1024 * 1024);
  put('spaces', P.spaces, 1, convo({ cwd: P.spaces, user: 'Hola, arregla el bug del sync', title: 'Arreglo sync',
    preface: [J({ type: 'user', isMeta: true, message: { role: 'user', content: 'Caveat: meta' }, cwd: P.spaces })] }), 10);
  put('quotes', P.quotes, 2, convo({ cwd: P.quotes, content: [{ type: 'text', text: 'Primera\nlinea\tcon "comillas" y \\ barra' }] }), 20);
  put('huge', P.huge, 3, convo({ cwd: P.huge, user: `${big} fin`, extra: Array.from({ length: 20 }, () => J({ type: 'assistant', pad: big.slice(0, 1024 * 1024), cwd: P.huge })) }), 30);
  /* (el prompt de 3 MB echa el cwd de la cabecera: sale de la cola, `tail -c`) */
  put('bad', P.bad, 4, `{{{ not json\n{"type":"assistant",,,}\n${J({ type: 'user', isSidechain: true, message: { role: 'user', content: 'sidechain' }, cwd: P.bad })}\n${convo({ cwd: P.bad, user: 'Despues de la basura' })}`, 40);
  put('cmd', P.cmd, 5, convo({ cwd: P.cmd, user: '<command-name>/init</command-name>\n<command-message>init</command-message>\n<command-args></command-args>' }), 50);
  put('uni', P.uni, 6, convo({ cwd: P.uni, user: 'ñandú 🚀 '.repeat(40), aiTitle: 'Título IA' }), 60);
  put('hyphen', P.hyphen, 7, convo({ cwd: undefined, user: 'Sin cwd' }), 70);
  put('empty', P.spaces, 8, `${J({ type: 'bridge-session', sessionId: 'x' })}\n`, 5);
  for (let i = 0; i < 205; i++) put(`f${i}`, P.filler, 100 + i, convo({ cwd: P.filler, user: `relleno ${i}` }), 200 + i);

  ch.localHome = home;
  const byId = (rows) => new Map(rows.map(r => [r.id, r]));
  let local = null;

  try {
    await check('CH1 cabecera: string/array, meta, sidechain, tool_result, slash command, titulo, malformada, UTF-8 cortado', () => {
      const h = ch.scanHead(convo({ cwd: '/a', user: 'hola', title: 'T', preface: [J({ type: 'user', isMeta: true, message: { role: 'user', content: 'meta' } })] }));
      assert.deepStrictEqual([h.user, h.title, h.cwds], ['hola', 'T', ['/a']]);
      const tool = J({ type: 'user', message: { role: 'user', content: [{ tool_use_id: 't', type: 'tool_result', content: 'r' }] } });
      assert.strictEqual(ch.scanHead(`${tool}\n${convo({ cwd: '/a', content: [{ type: 'text', text: 'arr' }] })}`).user, 'arr');
      assert.strictEqual(ch.preview(ch.unescapeRaw(ch.scanHead(convo({ user: '<command-name>/clear</command-name><command-args>x y</command-args>' })).user)), '/clear x y');
      assert.strictEqual(ch.unescapeRaw('abc\\u00'), 'abc');
      assert.strictEqual(ch.unescapeRaw('abc\\'), 'abc');
      assert.strictEqual(ch.unescapeRaw('a\\"b\\nc'), 'a"b\nc');
      const p = ch.preview('a'.repeat(200));
      assert.ok(p.length === 80 && p.endsWith('…'), p);
      assert.strictEqual(ch.preview('uno\n\n  dos\tTRES\u001b[31m'), 'uno dos TRES [31m');
    });

    await check('CH2 local (HOME falso con espacios): filas, orden, proyectos raros, fichero enorme, vacia fuera, decodificar con guiones, tope 200', async () => {
      const t = Date.now();
      local = await ch.listLocal({ home });
      const ms = Date.now() - t;
      assert.strictEqual(local.found, true);
      /* 213 ficheros: los 200 mas nuevos, menos la sesion vacia */
      assert.strictEqual(local.rows.length, 199, `filas: ${local.rows.length}`);
      for (let i = 1; i < local.rows.length; i++) assert.ok(local.rows[i - 1].mtime >= local.rows[i].mtime, 'no va de mas nueva a mas vieja');
      const m = byId(local.rows);
      assert.ok(!m.has(files.empty.id), 'la sesion sin mensaje de usuario sale');
      const r = (k) => { const x = m.get(files[k].id); assert.ok(x, `falta ${k}`); return x; };
      assert.deepStrictEqual([r('spaces').preview, r('spaces').title, r('spaces').project, r('spaces').projectName, r('spaces').guessed], ['Hola, arregla el bug del sync', 'Arreglo sync', P.spaces, 'My Project', false]);
      assert.strictEqual(r('spaces').mtime, files.spaces.mtime);
      assert.strictEqual(r('quotes').project, P.quotes);
      assert.strictEqual(r('quotes').preview, 'Primera linea con "comillas" y \\ barra');
      assert.ok(r('huge').preview.length === 80 && /^x+…$/.test(r('huge').preview), 'el enorme no se recorta');
      assert.ok(r('huge').size > 20 * 1024 * 1024, 'el enorme no es enorme');
      assert.deepStrictEqual([r('huge').project, r('huge').guessed], [P.huge, false], 'el cwd de la cola no se uso');
      assert.strictEqual(r('bad').preview, 'Despues de la basura');
      assert.strictEqual(r('cmd').preview, '/init');
      assert.ok(r('uni').preview.startsWith('ñandú 🚀 ñandú') && r('uni').preview.length === 80, r('uni').preview);
      assert.strictEqual(r('uni').title, 'Título IA');
      assert.deepStrictEqual([r('hyphen').project, r('hyphen').guessed], [P.hyphen, true]);
      assert.ok(ms < 3000, `tardo ${ms} ms (¿lee los ficheros enteros?)`);
      for (const x of local.rows) assert.ok(x.preview.length <= 80);
    });

    await check('CH3 el script remoto (sh + awk) da las mismas filas que la lectura local', () => {
      const out = execFileSync('/bin/sh', ['-c', ch.REMOTE_SCRIPT, 'x', '100'], { env: { PATH: '/usr/bin:/bin', HOME: home } });
      const remote = ch.parseRemote(out);
      assert.strictEqual(remote.rows.length, 100 - 1, `filas: ${remote.rows.length}`); // la vacia cuenta en los 100 ficheros
      const m = byId(local.rows);
      for (const r of remote.rows) {
        const l = m.get(r.id);
        assert.ok(l, `${r.id} no esta en local`);
        const want = { ...l, mtime: Math.floor(l.mtime / 1000) * 1000 };
        if (r.id === files.hyphen.id) {
          /* Sin cwd y con '-' en el nombre: remoto no puede preguntar al disco carpeta a carpeta */
          assert.strictEqual(r.guessed, true);
          continue;
        }
        assert.deepStrictEqual(r, want);
      }
      assert.ok(!/\\u00|�/.test(J(remote.rows)), 'UTF-8 roto en el remoto');
    });

    /* ── sshd de verdad con HOME = el falso ── */
    const ctl = path.join(tmp, 'ctl');
    fs.mkdirSync(ctl);
    const sftpServer = SFTP_SERVERS.find(p => fs.existsSync(p)) || '/usr/lib/openssh/sftp-server';
    const wrapper = path.join(tmp, 'wrap.sh');
    fs.writeFileSync(wrapper, [
      '#!/bin/sh',
      `HOME='${home}'; export HOME`,
      'cd "$HOME" || exit 1',
      `if [ -f '${ctl}/slow' ]; then sleep 8; fi`,
      'case "$SSH_ORIGINAL_COMMAND" in',
      `  *sftp*) exec '${sftpServer}' ;;`,
      '  "") exec /bin/sh ;;',
      'esac',
      'exec /bin/sh -c "$SSH_ORIGINAL_COMMAND"',
      '',
    ].join('\n'), { mode: 0o755 });
    let sshd = null; let sinSshd = null;
    try { sshd = await startRealSshd({ forceCommand: wrapper }); } catch (err) { sinSshd = err.message; }
    if (!sshd) {
      await check(`CH4-CH6 OMITIDAS: no se pudo arrancar sshd (${sinSshd})`, () => {});
    } else {
      const ventanaHk = hostKeyService.mainWindow;
      hostKeyService.setMainWindow({
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send: (canal, d) => { if (canal === 'ssh:host-key-prompt') setTimeout(() => hostKeyService.respond(d.requestId, true), 5); } },
      });
      const agente = process.env.SSH_AUTH_SOCK;
      delete process.env.SSH_AUTH_SOCK;
      let sid = null;
      try {
        await storeService.writeRaw('known-hosts', []);
        sid = await sshService.connect({
          host: '127.0.0.1', port: sshd.port, username: sshd.user, privateKey: sshd.privateKey,
          label: 'sshd del arnes', hostId: 'h-ch', purpose: 'sftp', timeout: 8000,
        });
        const client = sshService.getClient(sid);
        const sender = { isDestroyed: () => false, send: () => {} };
        const call = async (target, opts) => {
          const r = await handlers.get('claude-history:list')({ sender }, target, opts);
          if (!r.success) throw new Error(r.error);
          return r.data;
        };

        await check('CH4 remoto por claude-history:list: mismas filas, MISMA conexion, cache 60 s y fresh', async () => {
          ch.clear();
          const conexiones = sshService.sessions.size;
          let execs = 0;
          const realExec = client.exec;
          /* Solo las nuestras: ssh-service hace su propia deteccion de SO tras conectar */
          client.exec = function countedExec(...a) { if (String(a[0]).includes('.claude/projects')) execs++; return realExec.apply(this, a); };
          try {
            const a = await call({ kind: 'ssh', sessionId: sid });
            assert.strictEqual(a.found, true);
            assert.strictEqual(a.rows.length, 99);
            const m = byId(local.rows);
            for (const r of a.rows) {
              if (r.id === files.hyphen.id) continue;
              assert.deepStrictEqual(r, { ...m.get(r.id), mtime: Math.floor(m.get(r.id).mtime / 1000) * 1000 });
            }
            assert.strictEqual(execs, 1, `execs: ${execs}`);
            const b = await call({ kind: 'ssh', sessionId: sid });
            assert.strictEqual(b.cached, true);
            assert.strictEqual(execs, 1, 'la cache no sirvio');
            const c = await call({ kind: 'ssh', sessionId: sid }, { fresh: true });
            assert.ok(!c.cached);
            assert.strictEqual(execs, 2);
            assert.strictEqual(sshService.sessions.size, conexiones, 'abrio otra sesion');
            assert.strictEqual(sshService.getClient(sid), client, 'cambio el cliente ssh2');
            await assert.rejects(call({ kind: 'ssh', sessionId: 'no-existe' }), /not connected|another window/);
          } finally { client.exec = realExec; }
        });

        await check('CH5 salida acotada: un arbol que desborda el tope da filas validas y nunca mas de REMOTE_LIMIT', async () => {
          const wide = path.join(projects, enc(P.filler));
          const longCwd = (k) => `/${'d'.repeat(380)}/${k}`;
          const made = [];
          for (let i = 0; i < 120; i++) {
            const f = path.join(wide, `${uuid(900 + i)}.jsonl`);
            const pre = [0, 1, 2, 3].map(k => J({ type: 'system', cwd: longCwd(k) }));
            fs.writeFileSync(f, convo({ cwd: P.filler, user: `w${i} ${'z'.repeat(500)}`, title: 't'.repeat(500), aiTitle: 'a'.repeat(500), preface: pre }));
            made.push(f);
          }
          try {
            const raw = await new Promise((resolve, reject) => {
              client.exec(ch.remoteCommand(100), (e, s) => {
                if (e) return reject(e);
                const out = []; s.on('data', d => out.push(d)); s.on('close', () => resolve(Buffer.concat(out)));
              });
            });
            assert.ok(raw.length > 256 * 1024, `el arbol no desborda (${raw.length})`);
            const r = await ch.listRemote(client);
            assert.ok(r.rows.length > 0 && r.rows.length < 100, `filas: ${r.rows.length}`);
            for (const x of r.rows) assert.ok(x.id && x.preview && x.preview.length <= 80 && x.command, J(x));
            const small = await ch.listRemote(client, { maxOut: 3000 });
            assert.ok(small.rows.length < r.rows.length, `con 3000 bytes: ${small.rows.length}`);
            for (const x of small.rows) assert.ok(x.preview.startsWith('w'), J(x));
          } finally { for (const f of made) fs.unlinkSync(f); }
        });

        await check('CH6 timeout de 5 s respetado y el fallo no se cachea', async () => {
          ch.clear();
          fs.writeFileSync(path.join(ctl, 'slow'), '');
          try {
            const t = Date.now();
            await assert.rejects(call({ kind: 'ssh', sessionId: sid }), /timeout/);
            const ms = Date.now() - t;
            assert.ok(ms >= 4500 && ms < 6500, `tardo ${ms} ms`);
          } finally { fs.unlinkSync(path.join(ctl, 'slow')); }
          const ok = await call({ kind: 'ssh', sessionId: sid });
          assert.ok(!ok.cached && ok.rows.length === 99, 'cacheo el fallo');
        });
      } finally {
        if (sid) await sshService.disconnect(sid).catch(() => {});
        await sshd.stop();
        hostKeyService.setMainWindow(ventanaHk);
        if (agente) process.env.SSH_AUTH_SOCK = agente;
        await storeService.writeRaw('known-hosts', []);
        await storeService.writeRaw('connection-logs', []);
      }
    }

    await check('CH7 comando: comillas para espacios, \', $(), `; control e ids raros → null; se ejecuta con un claude falso', () => {
      const id = uuid(1);
      assert.strictEqual(ch.resumeCommand('/home/u/p', id), `cd '/home/u/p' && claude --resume ${id}`);
      assert.strictEqual(ch.resumeCommand(null, id), `claude --resume ${id}`);
      assert.strictEqual(ch.resumeCommand('/a\nb', id), null);
      assert.strictEqual(ch.resumeCommand('/a\u0003b', id), null);
      assert.strictEqual(ch.resumeCommand('/a', 'x; rm -rf ~'), null);
      assert.strictEqual(ch.resumeCommand('/a', '-rf'), null);
      const bin = path.join(tmp, 'bin');
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nprintf "%s|%s|%s\\n" "$(pwd)" "$1" "$2"\n', { mode: 0o755 });
      const weird = path.join(proj, 'sp ace\'s "dq" $(touch PWNED) `touch PWNED2` ; & |');
      fs.mkdirSync(weird);
      for (const p of [P.spaces, P.quotes, weird]) {
        const cmd = ch.resumeCommand(p, id);
        const out = execFileSync('/bin/sh', ['-c', cmd], { cwd: tmp, env: { PATH: `${bin}:/usr/bin:/bin` } }).toString();
        assert.strictEqual(out, `${p}|--resume|${id}\n`, `${cmd} → ${out}`);
      }
      assert.ok(!fs.existsSync(path.join(tmp, 'PWNED')) && !fs.existsSync(path.join(tmp, 'PWNED2')), 'se ejecuto algo del nombre');
      assert.strictEqual(local.rows.find(r => r.id === files.quotes.id).command, ch.resumeCommand(P.quotes, files.quotes.id));
    });

    await check('CH8 sin ~/.claude/projects: found:false (local y remoto); el servicio no escribe en disco', async () => {
      const empty = path.join(tmp, 'empty home');
      fs.mkdirSync(empty);
      assert.deepStrictEqual(await ch.listLocal({ home: empty }), { rows: [], found: false });
      const out = execFileSync('/bin/sh', ['-c', ch.REMOTE_SCRIPT, 'x', '100'], { env: { PATH: '/usr/bin:/bin', HOME: empty } });
      assert.deepStrictEqual(ch.parseRemote(out), { rows: [], found: false });
      const src = fs.readFileSync(path.join(ROOT, 'electron', 'services', 'claude-history.js'), 'utf-8');
      assert.ok(!/write(File)?(Sync)?\(|appendFile|mkdir|rename|createWriteStream|storeService/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'claude-history escribe o persiste algo');
      assert.deepStrictEqual(fs.readdirSync(empty), [], 'escribio en el HOME');
    });
  } finally {
    ch.localHome = null;
    ch.clear();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { seccionClaudeHistory };
