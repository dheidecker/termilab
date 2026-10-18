/**
 * Seccion CI del arnes del main (scripts/check-main.js): termilab-cli /
 * termilab-mcp en el PATH en macOS (electron/services/cli-install-service.js).
 * Todo con un HOME temporal y un Termilab.app falso: el ~/.local/bin real no
 * se toca (CI12 lo compara antes y despues).
 *
 *  CI1  linux / win32: supported:false con su reason, install/uninstall lanzan
 *       y el disco no cambia (ni se crea ~/.local/bin ni se toca lo que hay).
 *  CI2  darwin sin empaquetar → 'dev-build'; empaquetado sin scripts → 'scripts-missing'.
 *  CI3  install crea ~/.local/bin y los dos enlaces al bundle; installed:true.
 *  CI4  onPath con el PATH del shell de login: dentro → true y sin linea;
 *       fuera o shell fallido → false + export PATH="$HOME/.local/bin:$PATH" + ~/.zprofile.
 *  CI5  enlace a otra copia de Termilab → stale:true; install lo reemplaza.
 *  CI6  archivo regular ajeno: install lanza, no lo toca y NO crea el otro enlace.
 *  CI7  symlink ajeno (no a un bundle de Termilab): igual que CI6.
 *  CI8  uninstall borra los enlaces nuestros y los stale, nunca un archivo regular.
 *  CI9  readLoginPath real: /bin/sh -l con un ~/.profile que ensucia stdout.
 *  CI10 readLoginPath: shell colgado → null por timeout, sin colgar al arnes.
 *  CI11 canales cli:* registrados y por el sobre de wrapHandler (aqui: dev-build).
 *  CI12 el ~/.local/bin real de este usuario no cambio.
 *  CI13 el lanzador de build/mac, por el enlace, arranca el binario del bundle
 *       con cli.js del asar (solo si build/mac existe).
 *
 * Solo esta seccion: TERMILAB_CHECK_ONLY=CI.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

async function seccionCliInstall({ check, ROOT, handlers }) {
  const svcMod = require(path.join(ROOT, 'electron', 'services', 'cli-install-service.js'));
  const { CliInstallService, readLoginPath } = svcMod;
  const NAMES = ['termilab-cli', 'termilab-mcp'];

  // realpath: en macOS /var/folders es /private/var/folders
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'termilab-ci-')));
  let n = 0;
  const newHome = () => { const h = path.join(root, `home${++n}`); fs.mkdirSync(h); return h; };
  const fakeBundle = (name) => {
    const res = path.join(root, `${name}.app`, 'Contents', 'Resources');
    fs.mkdirSync(path.join(res, 'bin'), { recursive: true });
    for (const s of NAMES) fs.writeFileSync(path.join(res, 'bin', s), '#!/bin/sh\n', { mode: 0o755 });
    return res;
  };
  const resA = fakeBundle('Termilab');
  const resB = fakeBundle('Termilab copia');
  const snapshot = (dir) => {
    if (!fs.existsSync(dir)) return null;
    return fs.readdirSync(dir).sort().map(f => {
      const p = path.join(dir, f); const st = fs.lstatSync(p);
      return `${f}:${st.mode}:${st.size}:${st.isSymbolicLink() ? fs.readlinkSync(p) : ''}`;
    }).join('|');
  };
  const realBin = path.join(os.homedir(), '.local', 'bin');
  const realBefore = snapshot(realBin);

  const mac = (home, extra = {}) => new CliInstallService({
    platform: 'darwin', home, resourcesPath: resA, isPackaged: true, shell: '/bin/zsh',
    loginPath: async () => '/usr/bin:/bin', ...extra,
  });
  const link = (home, name) => path.join(home, '.local', 'bin', name);

  await check('CI1 linux/win32: supported:false, install/uninstall lanzan, disco intacto', async () => {
    for (const [platform, reason] of [['linux', 'linux-packaged'], ['win32', 'windows']]) {
      const home = newHome();
      let spawned = false;
      const svc = new CliInstallService({ platform, home, resourcesPath: resA, isPackaged: true, loginPath: async () => { spawned = true; return ''; } });
      const st = await svc.status();
      assert.strictEqual(st.supported, false, platform);
      assert.strictEqual(st.reason, reason, platform);
      assert.strictEqual(st.installed, false);
      assert.strictEqual(spawned, false, `${platform}: consulto el shell de login`);
      await assert.rejects(svc.install(), /./, `${platform}: install no lanzo`);
      await assert.rejects(svc.uninstall(), /./, `${platform}: uninstall no lanzo`);
      assert.ok(!fs.existsSync(path.join(home, '.local')), `${platform}: creo ~/.local`);
      // con algo ya en su sitio (un enlace a un bundle), uninstall tampoco lo borra
      fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
      fs.symlinkSync(path.join(resA, 'bin', 'termilab-cli'), link(home, 'termilab-cli'));
      const before = snapshot(path.join(home, '.local', 'bin'));
      await assert.rejects(svc.install());
      await assert.rejects(svc.uninstall());
      assert.strictEqual(snapshot(path.join(home, '.local', 'bin')), before, `${platform}: toco ~/.local/bin`);
    }
  });

  await check('CI2 darwin dev-build / scripts-missing', async () => {
    const home = newHome();
    let st = await mac(home, { isPackaged: false }).status();
    assert.deepStrictEqual([st.supported, st.reason], [false, 'dev-build']);
    const empty = path.join(root, 'Vacio.app', 'Contents', 'Resources');
    fs.mkdirSync(path.join(empty, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(empty, 'bin', 'termilab-cli'), '');   // falta el mcp
    st = await mac(home, { resourcesPath: empty }).status();
    assert.deepStrictEqual([st.supported, st.reason], [false, 'scripts-missing']);
    await assert.rejects(mac(home, { resourcesPath: empty }).install(), /missing/);
    assert.ok(!fs.existsSync(path.join(home, '.local')));
  });

  await check('CI3 install crea ~/.local/bin y los dos enlaces al bundle', async () => {
    const home = newHome();
    const svc = mac(home);
    let st = await svc.status();
    assert.deepStrictEqual([st.supported, st.reason, st.installed, st.stale], [true, null, false, false]);
    assert.strictEqual(st.binDir, path.join(home, '.local', 'bin'));
    st = await svc.install();
    for (const name of NAMES) {
      const l = link(home, name);
      assert.ok(fs.lstatSync(l).isSymbolicLink(), `${name} no es symlink`);
      assert.strictEqual(fs.readlinkSync(l), path.join(resA, 'bin', name));
    }
    assert.deepStrictEqual([st.installed, st.stale], [true, false]);
    assert.deepStrictEqual(st.entries.map(e => [e.name, e.linkPath, e.target]),
      NAMES.map(name => [name, link(home, name), path.join(resA, 'bin', name)]));
    // idempotente
    st = await svc.install();
    assert.strictEqual(st.installed, true);
  });

  await check('CI4 onPath con el PATH del shell de login', async () => {
    const home = newHome();
    const bin = path.join(home, '.local', 'bin');
    let st = await mac(home, { loginPath: async () => `/usr/bin:${bin}:/bin` }).status();
    assert.deepStrictEqual([st.onPath, st.pathLine, st.shellRc], [true, null, null]);
    st = await mac(home, { loginPath: async () => `/usr/bin:${bin}/:/bin` }).status();
    assert.strictEqual(st.onPath, true, 'barra final');
    st = await mac(home, { loginPath: async () => '/usr/bin:~/.local/bin' }).status();
    assert.strictEqual(st.onPath, true, '~ literal');
    st = await mac(home).status();
    assert.strictEqual(st.onPath, false);
    assert.strictEqual(st.pathLine, 'export PATH="$HOME/.local/bin:$PATH"');
    assert.strictEqual(st.shellRc, path.join(home, '.zprofile'));
    st = await mac(home, { loginPath: async () => null }).status();
    assert.deepStrictEqual([st.onPath, st.pathLine], [false, 'export PATH="$HOME/.local/bin:$PATH"'], 'shell fallido');
    st = await mac(home, { shell: '/bin/bash' }).status();
    assert.strictEqual(st.shellRc, path.join(home, '.bash_profile'));
    // no se escribio ningun rc
    assert.deepStrictEqual(fs.readdirSync(home).filter(f => f !== '.local'), []);
  });

  await check('CI5 enlace a otra copia de Termilab: stale, y install lo reemplaza', async () => {
    const home = newHome();
    await mac(home, { resourcesPath: resB }).install();
    let st = await mac(home).status();
    assert.deepStrictEqual([st.installed, st.stale], [false, true]);
    // tambien con la otra copia ya borrada (app movida a la papelera)
    const gone = path.join(root, 'Borrada.app', 'Contents', 'Resources', 'bin', 'termilab-mcp');
    fs.unlinkSync(link(home, 'termilab-mcp'));
    fs.symlinkSync(gone, link(home, 'termilab-mcp'));
    st = await mac(home).status();
    assert.strictEqual(st.stale, true, 'enlace colgante a un bundle no cuenta como stale');
    st = await mac(home).install();
    assert.deepStrictEqual([st.installed, st.stale], [true, false]);
    assert.strictEqual(fs.readlinkSync(link(home, 'termilab-mcp')), path.join(resA, 'bin', 'termilab-mcp'));
    assert.deepStrictEqual(fs.readdirSync(path.join(home, '.local', 'bin')).sort(), NAMES, 'quedaron temporales');
  });

  const foreignCase = async (label, plant) => {
    const home = newHome();
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    plant(link(home, 'termilab-mcp'));
    const before = snapshot(path.join(home, '.local', 'bin'));
    const contentBefore = fs.readFileSync(link(home, 'termilab-mcp'), 'utf-8');
    await assert.rejects(mac(home).install(), /termilab-mcp.*not a Termilab link/, `${label}: no lanzo o mensaje vago`);
    assert.strictEqual(snapshot(path.join(home, '.local', 'bin')), before, `${label}: toco el directorio (o creo termilab-cli)`);
    assert.strictEqual(fs.readFileSync(link(home, 'termilab-mcp'), 'utf-8'), contentBefore);
    const st = await mac(home).status();
    assert.deepStrictEqual([st.installed, st.stale], [false, false]);
    return home;
  };

  await check('CI6 archivo regular ajeno: install no lo pisa ni deja medio instalado', async () => {
    await foreignCase('regular', p => fs.writeFileSync(p, '#!/bin/sh\necho mio\n', { mode: 0o755 }));
  });

  await check('CI7 symlink ajeno (no a un bundle): install no lo pisa', async () => {
    const other = path.join(root, 'otro-script');
    fs.writeFileSync(other, 'ajeno\n');
    await foreignCase('symlink', p => fs.symlinkSync(other, p));
    // un bin/termilab-mcp que no esta dentro de X.app/Contents/Resources tampoco es nuestro
    const fakeish = path.join(root, 'opt', 'bin');
    fs.mkdirSync(fakeish, { recursive: true });
    fs.writeFileSync(path.join(fakeish, 'termilab-mcp'), 'casi\n');
    await foreignCase('casi-bundle', p => fs.symlinkSync(path.join(fakeish, 'termilab-mcp'), p));
  });

  await check('CI8 uninstall borra nuestros enlaces y los stale, nunca un archivo regular', async () => {
    let home = newHome();
    await mac(home).install();
    let st = await mac(home).uninstall();
    assert.deepStrictEqual(fs.readdirSync(path.join(home, '.local', 'bin')), []);
    assert.deepStrictEqual([st.installed, st.stale], [false, false]);
    // stale + regular ajeno
    home = newHome();
    await mac(home, { resourcesPath: resB }).install();
    fs.unlinkSync(link(home, 'termilab-mcp'));
    fs.writeFileSync(link(home, 'termilab-mcp'), 'del usuario\n');
    st = await mac(home).uninstall();
    assert.deepStrictEqual(fs.readdirSync(path.join(home, '.local', 'bin')), ['termilab-mcp']);
    assert.strictEqual(fs.readFileSync(link(home, 'termilab-mcp'), 'utf-8'), 'del usuario\n');
    // symlink ajeno tampoco
    fs.unlinkSync(link(home, 'termilab-mcp'));
    fs.symlinkSync('/bin/ls', link(home, 'termilab-mcp'));
    await mac(home).uninstall();
    assert.strictEqual(fs.readlinkSync(link(home, 'termilab-mcp')), '/bin/ls');
  });

  await check('CI9 readLoginPath real: /bin/sh -l con un .profile que ensucia stdout', async () => {
    if (process.platform === 'win32') return;
    const home = newHome();
    const bin = path.join(home, '.local', 'bin');
    fs.writeFileSync(path.join(home, '.profile'), `echo "hola desde el profile"\nexport PATH="${bin}:$PATH"\n`);
    const env = { PATH: '/usr/bin:/bin', HOME: home };
    const p = await readLoginPath({ shell: '/bin/sh', home, env });
    assert.ok(typeof p === 'string', 'no leyo el PATH');
    assert.ok(p.split(':').includes(bin), `PATH sin ${bin}: ${p}`);
    assert.ok(!p.includes('hola'), 'se colo la salida del profile');
    const st = await new CliInstallService({ platform: 'darwin', home, resourcesPath: resA, isPackaged: true, shell: '/bin/sh', env }).status();
    assert.strictEqual(st.onPath, true);
    fs.writeFileSync(path.join(home, '.profile'), 'echo nada\n');
    const st2 = await new CliInstallService({ platform: 'darwin', home, resourcesPath: resA, isPackaged: true, shell: '/bin/sh', env }).status();
    assert.deepStrictEqual([st2.onPath, st2.shellRc], [false, path.join(home, '.profile')]);
  });

  await check('CI10 shell de login colgado o inexistente → null, sin colgar', async () => {
    if (process.platform === 'win32') return;
    const home = newHome();
    const slow = path.join(root, 'shell-lento');
    fs.writeFileSync(slow, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    const t0 = Date.now();
    assert.strictEqual(await readLoginPath({ shell: slow, home, env: { PATH: '/usr/bin:/bin' } }), null);
    assert.ok(Date.now() - t0 < 6000, `tardo ${Date.now() - t0} ms`);
    assert.strictEqual(await readLoginPath({ shell: path.join(root, 'no-existe'), home, env: {} }), null);
  });

  await check('CI11 canales cli:* registrados y por el sobre de wrapHandler', async () => {
    for (const c of ['cli:status', 'cli:install', 'cli:uninstall']) assert.ok(handlers.has(c), `${c} sin handler`);
    const st = await handlers.get('cli:status')({});
    assert.strictEqual(st.success, true);
    // el arnes corre fuera de un .app: en darwin es dev-build, en linux/win32 lo suyo
    const expected = { darwin: 'dev-build', win32: 'windows' }[process.platform] || 'linux-packaged';
    assert.deepStrictEqual([st.data.supported, st.data.reason], [false, expected]);
    const ins = await handlers.get('cli:install')({});
    assert.strictEqual(ins.success, false);
    assert.ok(ins.error && ins.error.length > 20, 'error ilegible');
    const src = fs.readFileSync(path.join(ROOT, 'electron', 'ipc-handlers.js'), 'utf-8');
    const rm = src.slice(src.indexOf('function removeIpcHandlers'));
    for (const c of ['cli:status', 'cli:install', 'cli:uninstall']) assert.ok(rm.includes(`'${c}'`), `${c} no esta en removeIpcHandlers`);
  });

  await check('CI12 el ~/.local/bin real no cambio', () => {
    assert.strictEqual(snapshot(realBin), realBefore);
  });

  await check('CI13 lanzador de build/mac por el enlace: arranca el binario del bundle con cli.js', async () => {
    const launcher = path.join(ROOT, 'build', 'mac', 'termilab-cli');
    if (!fs.existsSync(launcher) || process.platform === 'win32') return;
    const app = path.join(root, 'Lanzador.app', 'Contents');
    fs.mkdirSync(path.join(app, 'Resources', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(app, 'MacOS'), { recursive: true });
    for (const s of NAMES) {
      const src = path.join(ROOT, 'build', 'mac', s);
      fs.copyFileSync(src, path.join(app, 'Resources', 'bin', s));
      fs.chmodSync(path.join(app, 'Resources', 'bin', s), 0o755);
    }
    fs.writeFileSync(path.join(app, 'MacOS', 'Termilab'), '#!/bin/sh\nprintf "%s|" "$ELECTRON_RUN_AS_NODE" "$@"\n', { mode: 0o755 });
    const home = newHome();
    await new CliInstallService({ platform: 'darwin', home, resourcesPath: path.join(app, 'Resources'), isPackaged: true, loginPath: async () => '' }).install();
    const out = execFileSync(link(home, 'termilab-cli'), ['hosts', '--json'], { encoding: 'utf-8' });
    const asar = path.join(app, 'Resources', 'app.asar', 'electron', 'agent');
    assert.strictEqual(out, `1|${path.join(asar, 'cli.js')}|hosts|--json|`);
    const outMcp = execFileSync(link(home, 'termilab-mcp'), [], { encoding: 'utf-8' });
    assert.ok(outMcp.startsWith('1|') && outMcp.includes(path.join(app, 'Resources', 'app.asar')), `mcp: ${outMcp}`);
  });

  fs.rmSync(root, { recursive: true, force: true });
}

module.exports = { seccionCliInstall };
