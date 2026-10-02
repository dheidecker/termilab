/**
 * Seccion N del arnes del main (scripts/check-main.js): terminal local en Linux
 * cuando Termilab corre con no_new_privs (relanzado por el actualizador).
 *
 *  N1-N4  funciones puras de electron/services/local-shell-escape.js: que
 *         variables cruzan, cuando se usa systemd-run y con que argumentos.
 *  N5     de verdad, si aqui hay systemd --user: el local-shell-service real
 *         bajo Electron-como-node (node-pty esta compilado para su ABI) abre un
 *         bash via systemd-run y se mira NoNewPrivs=0, stty size tras resize,
 *         Ctrl+C, codigo de salida, kill y que no quede ninguna unidad.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

async function seccionLocalShell({ check, ROOT }) {
  const esc = require(path.join(ROOT, 'electron', 'services', 'local-shell-escape.js'));

  await check('N1 filterEnv deja pasar lo de la sesion y nada de Electron/Chromium ni secretos ajenos', () => {
    const base = {
      PATH: '/usr/bin', HOME: '/home/d', USER: 'd', LOGNAME: 'd', SHELL: '/bin/bash', LANG: 'es_CL.UTF-8',
      LC_ALL: 'es_CL.UTF-8', LC_TIME: 'C', DISPLAY: ':1', WAYLAND_DISPLAY: 'wayland-0', XDG_RUNTIME_DIR: '/run/user/1000',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', SSH_AUTH_SOCK: '/run/user/1000/ssh', XAUTHORITY: '/x',
      ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1', CHROME_DESKTOP: 'termilab.desktop', GOOGLE_API_KEY: 'k',
      NODE_OPTIONS: '--inspect', LD_PRELOAD: '/x.so', LD_LIBRARY_PATH: '/opt/Termilab', GITHUB_TOKEN: 'ghp_x',
      AWS_SECRET_ACCESS_KEY: 's', ORIGINAL_XDG_CURRENT_DESKTOP: 'GNOME', GDK_BACKEND: 'x11', TERM: 'dumb',
    };
    const env = esc.filterEnv(base, { TERM: 'xterm-256color', COLORTERM: 'truecolor', MIO: 'a b' });
    assert.deepStrictEqual(Object.keys(env).sort(), [
      'COLORTERM', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'HOME', 'LANG', 'LC_ALL', 'LC_TIME', 'LOGNAME', 'MIO',
      'PATH', 'SHELL', 'SSH_AUTH_SOCK', 'TERM', 'USER', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR',
    ]);
    assert.strictEqual(env.TERM, 'xterm-256color', 'lo que pone el servicio no gana');
    assert.strictEqual(env.MIO, 'a b');
    const raro = esc.filterEnv({ LANG: 'a\nb', LC_X: 'tab\tok', PATH: '/bin' }, { 'MAL-NOMBRE': 'x', NULO: null });
    assert.deepStrictEqual(raro, { LC_X: 'tab\tok', PATH: '/bin' }, 'un valor con salto de linea o un nombre invalido cruzo');
  });

  await check('N2 parseNoNewPrivs lee /proc/<pid>/status', () => {
    assert.strictEqual(esc.parseNoNewPrivs('Name:\tx\nNoNewPrivs:\t1\nSeccomp:\t2\n'), true);
    assert.strictEqual(esc.parseNoNewPrivs('Name:\tx\nNoNewPrivs:\t0\n'), false);
    assert.strictEqual(esc.parseNoNewPrivs('Name:\tx\n'), false, 'kernel sin el campo');
    assert.strictEqual(esc.parseNoNewPrivs(''), false);
  });

  await check('N3 decideLaunch: systemd-run solo en Linux con NNP=1, systemd-run, bus y gestor; si no, directo', () => {
    const ok = { platform: 'linux', env: { DBUS_SESSION_BUS_ADDRESS: 'unix:x' }, noNewPrivs: true, systemdRun: '/usr/bin/systemd-run', managerReachable: true };
    const modo = (cambio) => esc.decideLaunch({ ...ok, ...cambio }).mode;
    assert.strictEqual(modo({}), 'systemd-run');
    assert.strictEqual(modo({ env: { XDG_RUNTIME_DIR: '/run/user/1000' } }), 'systemd-run', 'XDG_RUNTIME_DIR basta para el bus');
    assert.strictEqual(modo({ platform: 'darwin' }), 'direct');
    assert.strictEqual(modo({ platform: 'win32' }), 'direct');
    assert.strictEqual(modo({ noNewPrivs: false }), 'direct', 'NNP=0: como siempre');
    assert.strictEqual(modo({ systemdRun: null }), 'direct', 'sin systemd-run');
    assert.strictEqual(modo({ managerReachable: false }), 'direct', 'gestor de usuario caido');
    assert.strictEqual(modo({ env: {} }), 'direct', 'sin bus de sesion');
    assert.strictEqual(modo({ env: { ...ok.env, TERMILAB_DIRECT_PTY: '1' } }), 'direct', 'la escotilla no fuerza el camino viejo');
    assert.strictEqual(modo({ env: { ...ok.env, TERMILAB_DIRECT_PTY: '0' } }), 'systemd-run');
  });

  await check('N4 buildSystemdRunArgs: pty, espera, recoge, mismo cwd, unidad con nombre, -- antes del shell', () => {
    const args = esc.buildSystemdRunArgs({ unit: esc.unitName('ab-12;rm'), shell: '/bin/zsh', shellArgs: ['--login'], setenv: { TERM: 'xterm-256color', X: 'a b' } });
    assert.deepStrictEqual(args, [
      '--user', '--pty', '--quiet', '--collect', '--wait', '--same-dir', '--unit=termilab-shell-ab-12rm',
      '--setenv=TERM=xterm-256color', '--setenv=X=a b', '--', '/bin/zsh', '--login',
    ]);
  });

  // ── N5: de verdad ──
  const electronBin = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron');
  let motivo = null;
  if (process.platform !== 'linux') motivo = 'no es Linux';
  else if (!fs.existsSync(electronBin)) motivo = 'sin node_modules/electron';
  else {
    try { execFileSync('sh', ['-c', 'command -v systemd-run']); } catch (_) { motivo = 'sin systemd-run'; }
    if (!motivo) {
      let estado = '';
      try { estado = execFileSync('systemctl', ['--user', 'is-system-running']).toString().trim(); } catch (e) { estado = String(e.stdout || '').trim(); }
      if (!['running', 'degraded'].includes(estado)) motivo = `systemd --user no responde (${estado || 'nada'})`;
    }
  }
  if (motivo) {
    await check(`N5 shell via systemd-run de verdad -- OMITIDA: ${motivo}`, () => {});
    return;
  }

  const r = await new Promise((resolve, reject) => {
    execFile(electronBin, [path.join(__dirname, 'local-shell-driver.js'), ROOT],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 60000 },
      (err, stdout, stderr) => {
        const line = String(stdout).trim().split('\n').filter(l => l.startsWith('{')).pop();
        if (!line) return reject(new Error(`el driver no devolvio nada: ${err && err.message} ${String(stderr).slice(-400)}`));
        resolve(JSON.parse(line));
      });
  }).catch(err => ({ error: err.message }));

  await check('N5 shell via systemd-run de verdad: NNP=0, cwd, stty sigue al resize, Ctrl+C, entorno limpio, exit 7, kill, sin unidades', () => {
    assert.ok(!r.error, r.error);
    const s = r.steps;
    assert.strictEqual(s.unitWhileRunning.length, 1, `la unidad no estaba viva: ${s.unitWhileRunning}`);
    assert.strictEqual(s.nnp, '0', `NoNewPrivs dentro del shell = ${s.nnp}`);
    assert.ok(s.cwdOk, 'el shell no arranco en el cwd pedido');
    assert.strictEqual(s.sizeBefore, '24 80');
    assert.strictEqual(s.sizeAfter, '40 132', 'stty size no siguio al resize');
    assert.strictEqual(s.ctrlC, '130', 'Ctrl+C no interrumpio el sleep');
    assert.strictEqual(s.leak, '0', 'ELECTRON_/CHROME_/GOOGLE_/GITHUB_TOKEN cruzaron al shell');
    assert.strictEqual(s.term, 'xterm-256color');
    assert.strictEqual(s.colorterm, 'truecolor');
    assert.strictEqual(s.exitCode, '7', `codigo de salida ${s.exitCode}`);
    assert.deepStrictEqual(s.unitAfterExit, [], 'la unidad sobrevivio a exit');
    assert.ok(s.killClosed, 'kill no emitio local:close');
    assert.deepStrictEqual(s.unitAfterKill, [], 'la unidad sobrevivio a cerrar la pestana');
    assert.deepStrictEqual(s.leftover, [], `quedaron unidades termilab-shell-*: ${s.leftover}`);
    const nuevas = r.runAfter.filter(u => !r.runBefore.includes(u));
    assert.deepStrictEqual(nuevas, [], `quedaron unidades run-*: ${nuevas}`);
  });
}

module.exports = { seccionLocalShell };
