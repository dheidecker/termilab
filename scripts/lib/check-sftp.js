/**
 * Seccion F del arnes del main (scripts/check-main.js): el SFTP de dos paneles.
 *
 *  L*  local-fs-service: nombres raros (espacios, unicode, comillas, $()),
 *      rutas relativas / NUL / "..", papelera en vez de unlink.
 *  F*  sftp-service + transfer-service + sftp-edit-service contra un sshd de
 *      OpenSSH DE VERDAD (scripts/lib/real-sshd.js: usuario normal, 127.0.0.1,
 *      puerto libre). El servidor ssh2 de pruebas no tiene subsistema SFTP.
 *
 * Decision sobre cancelar a mitad: cada fichero se escribe en
 * `.<nombre>.<rand>.termilab-part` y solo se renombra al acabar, asi que
 * cancelar no deja NI el destino NI el .termilab-part (y un destino que se
 * estaba sobrescribiendo sigue intacto). Es lo que comprueban F4/F5.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { startRealSshd } = require('./real-sshd');

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ODD_NAMES = [
  'with spaces.txt',
  'ñandú – año.txt',
  '日本語 🚀.md',
  `it's "quoted".txt`,
  '$(touch PWNED) `id`.sh',
  '-dash-first',
];

function writeRandom(file, bytes) {
  const fd = fs.openSync(file, 'w');
  const chunk = crypto.randomBytes(1024 * 1024);
  for (let left = bytes; left > 0; left -= chunk.length) fs.writeSync(fd, chunk, 0, Math.min(chunk.length, left));
  fs.closeSync(fd);
}

function partsIn(dir) {
  return fs.readdirSync(dir).filter(n => n.endsWith('.termilab-part'));
}

async function seccionSftp({ check, ROOT, getBridge }) {
  const svc = (n) => require(path.join(ROOT, 'electron', 'services', n));
  const localFs = svc('local-fs-service.js');
  const sftpService = svc('sftp-service.js');
  const transferService = svc('transfer-service.js');
  const editService = svc('sftp-edit-service.js');
  const sshService = svc('ssh-service.js');
  const hostKeyService = svc('host-key-service.js');
  const storeService = svc('store-service.js');
  const bridge = getBridge();

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'termilab-sftp-arnes-'));
  const localDir = path.join(base, 'local');
  const remoteDir = path.join(base, 'remote');   // el sshd es esta maquina: "remoto" es otra carpeta
  fs.mkdirSync(localDir);
  fs.mkdirSync(remoteDir);

  // Papelera y openPath falsos: se registra que se llamaron, no se abre nada.
  const trashDir = path.join(base, 'trash');
  fs.mkdirSync(trashDir);
  const trashed = [];
  const opened = [];
  const fakeShell = {
    trashItem: async (p) => { trashed.push(p); await fsp.rename(p, path.join(trashDir, `${trashed.length}-${path.basename(p)}`)); },
    openPath: async (p) => { opened.push(p); return ''; },
  };
  localFs._shell = fakeShell;
  editService._shell = fakeShell;

  // ── L. local-fs ──────────────────────────────────────────

  await check('L1 local-fs: crear, listar, renombrar, copiar y chmod con espacios, unicode, comillas y $() — sin shell', async () => {
    for (const name of ODD_NAMES) {
      await localFs.createFile(localDir, name);
      await localFs.mkdir(localDir, `dir ${name}`);
    }
    const listed = (await localFs.list(localDir)).map(e => e.name).sort();
    assert.deepStrictEqual(listed, [...ODD_NAMES, ...ODD_NAMES.map(n => `dir ${n}`)].sort());
    const e = (await localFs.list(localDir)).find(x => x.name === ODD_NAMES[2]);
    assert.strictEqual(e.type, 'file');
    assert.strictEqual(e.path, path.join(localDir, ODD_NAMES[2]));
    await localFs.rename(path.join(localDir, ODD_NAMES[3]), `renamed ${ODD_NAMES[3]}`);
    assert.ok(fs.existsSync(path.join(localDir, `renamed ${ODD_NAMES[3]}`)));
    await assert.rejects(localFs.rename(path.join(localDir, ODD_NAMES[0]), ODD_NAMES[1]), /already exists/, 'rename piso un fichero existente');
    await localFs.copy(path.join(localDir, `dir ${ODD_NAMES[4]}`), localDir, 'copia $(x)');
    assert.ok(fs.statSync(path.join(localDir, 'copia $(x)')).isDirectory());
    await assert.rejects(localFs.copy(path.join(localDir, ODD_NAMES[0]), localDir, ODD_NAMES[1]), /already exists/);
    await localFs.chmod(path.join(localDir, ODD_NAMES[0]), 0o640);
    assert.strictEqual(fs.statSync(path.join(localDir, ODD_NAMES[0])).mode & 0o777, 0o640);
    assert.strictEqual((await localFs.stat(path.join(localDir, 'no-existe'))), null);
    // Ningun $() ni `` se ejecuto en ningun sitio
    for (const where of [localDir, process.cwd(), ROOT, os.homedir()]) {
      assert.ok(!fs.existsSync(path.join(where, 'PWNED')), `se ejecuto un $() en ${where}`);
    }
  });

  await check('L2 local-fs: rutas relativas, NUL, "..", separadores en el nombre y copiar una carpeta dentro de si misma se rechazan', async () => {
    const outside = path.join(base, 'evil');
    const bad = [
      () => localFs.mkdir(localDir, '../evil'),
      () => localFs.mkdir(localDir, '..'),
      () => localFs.mkdir(localDir, '.'),
      () => localFs.createFile(localDir, 'a/b'),
      () => localFs.createFile(localDir, 'x\0y'),
      () => localFs.rename(path.join(localDir, ODD_NAMES[0]), '../evil'),
      () => localFs.list('relative/path'),
      () => localFs.list(`${localDir}\0/x`),
      () => localFs.stat(''),
      () => localFs.copy(path.join(localDir, `dir ${ODD_NAMES[0]}`), path.join(localDir, `dir ${ODD_NAMES[0]}`), 'inside'),
      () => localFs.chmod(path.join(localDir, ODD_NAMES[0]), 'rwx'),
    ];
    for (const [i, fn] of bad.entries()) {
      await assert.rejects(fn(), undefined, `el caso ${i} no fallo`);
    }
    assert.ok(!fs.existsSync(outside), 'algo se creo fuera de la carpeta');
    // Una ruta con ".." que se normaliza DENTRO de lo absoluto es valida (es tu disco)
    const listed = await localFs.list(path.join(localDir, `dir ${ODD_NAMES[0]}`, '..'));
    assert.ok(listed.length > 0);
  });

  await check('L3 borrar local = papelera del sistema (shell.trashItem), nunca unlink; raiz y home se niegan', async () => {
    const f = path.join(localDir, ODD_NAMES[5]);
    await localFs.trash(f);
    assert.deepStrictEqual(trashed, [f]);
    assert.ok(!fs.existsSync(f));
    assert.ok(fs.readdirSync(trashDir).some(n => n.endsWith(ODD_NAMES[5])), 'no llego a la papelera');
    await assert.rejects(localFs.trash('/'), /root/);
    await assert.rejects(localFs.trash(os.homedir()), /home/);
    await assert.rejects(localFs.trash(path.join(localDir, 'no-existe')), /No such/);
    const src = fs.readFileSync(path.join(ROOT, 'electron', 'services', 'local-fs-service.js'), 'utf-8');
    assert.ok(!/\b(unlink|rm|rmdir)\s*\(/.test(src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), 'local-fs-service borra con unlink/rm');
    assert.ok(!/child_process/.test(src), 'local-fs-service usa child_process');
  });

  await check('L4 por IPC (preload -> handler): localFs.* desenvuelve el sobre y un error llega como rechazo', async () => {
    assert.strictEqual(await bridge.localFs.home(), os.homedir());
    const names = (await bridge.localFs.list(localDir)).map(e => e.name);
    assert.ok(names.includes(ODD_NAMES[0]));
    await assert.rejects(bridge.localFs.mkdir(localDir, '../x'), /name|separator/);
    assert.strictEqual(typeof bridge.sftp.pathForFile, 'function');
  });

  // ── F. SFTP contra un sshd real ──────────────────────────

  let sshd = null;
  let sinSshd = null;
  try {
    sshd = await startRealSshd();
  } catch (err) {
    sinSshd = err.message;
  }

  const ventanaHk = hostKeyService.mainWindow;
  hostKeyService.setMainWindow({
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: (canal, d) => { if (canal === 'ssh:host-key-prompt') setTimeout(() => hostKeyService.respond(d.requestId, true), 5); } },
  });
  const progress = [];
  const edits = [];
  const ventanaTr = transferService.mainWindow;
  const ventanaEd = editService.mainWindow;
  // onProgress: ganchos que corren DENTRO del push (cancelar ahi es "a mitad" de verdad,
  // por rapido que vaya localhost).
  const onProgress = [];
  transferService.setMainWindow({ isDestroyed: () => false, webContents: { send: (c, d) => { if (c === 'sftp:transfer-progress') { progress.push(d); for (const f of onProgress.slice()) f(d); } } } });
  const cancelAt = (id, bytes) => {
    const hook = (d) => {
      if (d.id !== id || d.transferred < bytes) return;
      onProgress.splice(onProgress.indexOf(hook), 1);
      transferService.cancel(id);
    };
    onProgress.push(hook);
  };
  editService.setMainWindow({ isDestroyed: () => false, webContents: { send: (c, d) => { if (c === 'sftp:edit-event') edits.push(d); } } });
  const agente = process.env.SSH_AUTH_SOCK;
  delete process.env.SSH_AUTH_SOCK;
  editService.debounceMs = 50;

  const cfg = (extra = {}) => ({
    host: '127.0.0.1', port: sshd && sshd.port, username: sshd && sshd.user, privateKey: sshd && sshd.privateKey,
    label: 'sshd del arnes', hostId: 'h-sftp', purpose: 'sftp', timeout: 8000, ...extra,
  });
  const sessions = [];
  const connect = async (extra) => { const id = await sshService.connect(cfg(extra)); sessions.push(id); return id; };
  const R = { kind: 'remote' };
  const L = { kind: 'local' };

  try {
    await storeService.writeRaw('known-hosts', []);
    await storeService.writeRaw('connection-logs', []);
    let sid = null;
    const results50 = [];

    await check('F1 conexion propia purpose:sftp contra sshd real: sin shell, realpath = home, y en Logs como sftp con usuario', async () => {
      assert.ok(sshd, `sin sshd: ${sinSshd}`);
      sid = await connect();
      assert.ok(sshService.isConnected(sid));
      assert.strictEqual(sshService.sessions.get(sid).stream, null, 'la conexion SFTP abrio una shell');
      assert.strictEqual(await bridge.sftp.realpath(sid, '.'), os.homedir());
      await sleep(150);
      const logs = await storeService.getConnectionLogs();
      assert.strictEqual(logs.length, 1);
      assert.strictEqual(logs[0].type, 'sftp');
      assert.strictEqual(logs[0].username, sshd.user);
      assert.strictEqual(logs[0].port, sshd.port);
      assert.ok(!('privateKey' in logs[0]) && !JSON.stringify(logs).includes('PRIVATE KEY'));
      assert.strictEqual((await storeService.getKnownHosts()).length, 1, 'la clave del host no paso por el verificador');
    });

    await check('F2 remoto por IPC: list, mkdir, createFile, rename (no pisa), stat null, chmod, delete recursivo (permanente)', async () => {
      assert.ok(sid, 'sin sesion');
      for (const n of ODD_NAMES) await bridge.sftp.createFile(sid, remoteDir, n);
      await bridge.sftp.mkdir(sid, remoteDir, 'carpeta a borrar');
      await bridge.sftp.mkdir(sid, path.join(remoteDir, 'carpeta a borrar'), 'dentro');
      await bridge.sftp.createFile(sid, path.join(remoteDir, 'carpeta a borrar', 'dentro'), 'hoja.txt');
      fs.symlinkSync(os.homedir(), path.join(remoteDir, 'carpeta a borrar', 'enlace-a-home'));
      const list = await bridge.sftp.list(sid, remoteDir);
      assert.deepStrictEqual(list.map(e => e.name).sort(), [...ODD_NAMES, 'carpeta a borrar'].sort());
      const dirEntry = list.find(e => e.name === 'carpeta a borrar');
      assert.strictEqual(dirEntry.type, 'directory');
      const inner = await bridge.sftp.list(sid, path.join(remoteDir, 'carpeta a borrar'));
      assert.strictEqual(inner.find(e => e.name === 'enlace-a-home').linkType, 'directory');
      await assert.rejects(bridge.sftp.createFile(sid, remoteDir, ODD_NAMES[0]), /already exists/);
      await assert.rejects(bridge.sftp.mkdir(sid, remoteDir, '../fuera'), /not a valid name/);
      await assert.rejects(bridge.sftp.rename(sid, path.join(remoteDir, ODD_NAMES[0]), ODD_NAMES[1]), /already exists/);
      await bridge.sftp.rename(sid, path.join(remoteDir, ODD_NAMES[0]), 'nuevo nombre.txt');
      assert.ok(fs.existsSync(path.join(remoteDir, 'nuevo nombre.txt')));
      assert.strictEqual(await bridge.sftp.stat(sid, path.join(remoteDir, ODD_NAMES[0])), null);
      await bridge.sftp.chmod(sid, path.join(remoteDir, 'nuevo nombre.txt'), 0o604);
      assert.strictEqual(fs.statSync(path.join(remoteDir, 'nuevo nombre.txt')).mode & 0o777, 0o604);
      assert.strictEqual((await bridge.sftp.stat(sid, path.join(remoteDir, 'nuevo nombre.txt'))).permissions, 'rw----r--');
      await bridge.sftp.delete(sid, path.join(remoteDir, 'carpeta a borrar'));
      assert.ok(!fs.existsSync(path.join(remoteDir, 'carpeta a borrar')));
      assert.ok(fs.existsSync(os.homedir()), 'borrar siguio el enlace');
      await assert.rejects(bridge.sftp.delete(sid, '/'), /root/);
      await assert.rejects(bridge.sftp.list(sid, 'relativa'), /absolute/);
    });

    await check('F3 subir fichero y carpeta recursiva (nombres raros), bajar, bytes identicos, progreso con total', async () => {
      assert.ok(sid, 'sin sesion');
      const tree = path.join(localDir, 'árbol con espacios');
      fs.mkdirSync(path.join(tree, 'sub', 'más hondo'), { recursive: true });
      writeRandom(path.join(tree, 'a.bin'), 300 * 1024);
      writeRandom(path.join(tree, 'sub', `it's.bin`), 1024 * 1024 + 7);
      fs.writeFileSync(path.join(tree, 'sub', 'más hondo', '日本 🚀.txt'), 'hola\n');
      fs.mkdirSync(path.join(tree, 'vacía'));
      progress.length = 0;
      const up = await bridge.sftp.transferStart('t-up', { src: L, srcPath: tree, dst: { ...R, sessionId: sid }, dstDir: remoteDir });
      assert.strictEqual(up.files, 3);
      assert.strictEqual(up.bytes, 300 * 1024 + 1024 * 1024 + 7 + 5);
      for (const rel of ['a.bin', `sub/it's.bin`, 'sub/más hondo/日本 🚀.txt']) {
        assert.strictEqual(sha(path.join(remoteDir, 'árbol con espacios', rel)), sha(path.join(tree, rel)), rel);
      }
      assert.ok(fs.statSync(path.join(remoteDir, 'árbol con espacios', 'vacía')).isDirectory(), 'la carpeta vacia no llego');
      const last = progress.filter(p => p.id === 't-up').pop();
      assert.strictEqual(last.transferred, last.total);
      assert.strictEqual(last.filesDone, 3);
      // un fichero suelto
      await bridge.sftp.transferStart('t-up1', { src: L, srcPath: path.join(tree, 'a.bin'), dst: { ...R, sessionId: sid }, dstDir: remoteDir, name: 'suelto.bin' });
      assert.strictEqual(sha(path.join(remoteDir, 'suelto.bin')), sha(path.join(tree, 'a.bin')));
      // bajar
      const dl = path.join(base, 'bajadas');
      fs.mkdirSync(dl);
      await bridge.sftp.transferStart('t-dl', { src: { ...R, sessionId: sid }, srcPath: path.join(remoteDir, 'árbol con espacios'), dst: L, dstDir: dl });
      assert.strictEqual(sha(path.join(dl, 'árbol con espacios', 'sub', `it's.bin`)), sha(path.join(tree, 'sub', `it's.bin`)));
      assert.deepStrictEqual(partsIn(remoteDir), []);
    });

    const big = path.join(localDir, 'grande-50MB.bin');
    await check('F4 50 MB: eventos de progreso crecientes; cancelar a mitad rechaza y no deja ni destino ni .termilab-part', async () => {
      assert.ok(sid, 'sin sesion');
      writeRandom(big, 50 * 1024 * 1024);
      progress.length = 0;
      const t0 = Date.now();
      await transferService.start('t-50', { src: L, srcPath: big, dst: { ...R, sessionId: sid }, dstDir: remoteDir });
      const ms = Date.now() - t0;
      const ev = progress.filter(p => p.id === 't-50');
      const intermedios = ev.filter(e => e.transferred > 0 && e.transferred < e.total);
      assert.ok(intermedios.length >= 1, `sin eventos intermedios (${ev.length} en total)`);
      for (let i = 1; i < ev.length; i++) assert.ok(ev[i].transferred >= ev[i - 1].transferred, 'el progreso retrocedio');
      assert.strictEqual(ev[ev.length - 1].transferred, 50 * 1024 * 1024);
      assert.strictEqual(ev[0].total, 50 * 1024 * 1024);
      assert.strictEqual(sha(path.join(remoteDir, 'grande-50MB.bin')), sha(big));
      results50.push(`subida 50 MB: ${ev.length} eventos, ${(50 / (ms / 1000)).toFixed(0)} MB/s`);

      // Cancelar a mitad (otro nombre, para no tener conflicto)
      progress.length = 0;
      cancelAt('t-50c', 10 * 1024 * 1024);
      await assert.rejects(transferService.start('t-50c', { src: L, srcPath: big, dst: { ...R, sessionId: sid }, dstDir: remoteDir, name: 'cancelado.bin' }), /Cancelled/);
      const hasta = Math.max(...progress.filter(e => e.id === 't-50c').map(e => e.transferred));
      assert.ok(hasta < 50 * 1024 * 1024, 'se cancelo cuando ya habia terminado');
      results50.push(`cancelada a ${(hasta / 1048576).toFixed(1)} MB`);
      assert.ok(!fs.existsSync(path.join(remoteDir, 'cancelado.bin')), 'quedo el destino a medias');
      assert.deepStrictEqual(partsIn(remoteDir), [], 'quedo el .termilab-part');
      assert.ok(!transferService.jobs.has('t-50c'));
      // Y bajando (remoto -> local), igual
      progress.length = 0;
      cancelAt('t-50d', 10 * 1024 * 1024);
      await assert.rejects(bridge.sftp.transferStart('t-50d', { src: { ...R, sessionId: sid }, srcPath: path.join(remoteDir, 'grande-50MB.bin'), dst: L, dstDir: base, name: 'bajada-cancelada.bin' }), /Cancelled/);
      assert.ok(!fs.existsSync(path.join(base, 'bajada-cancelada.bin')));
      assert.deepStrictEqual(partsIn(base), []);
    });
    await check('F5 sobrescribir y cancelar a mitad: el fichero original sigue intacto', async () => {
      assert.ok(sid, 'sin sesion');
      const target = path.join(remoteDir, 'original.txt');
      fs.writeFileSync(target, 'ORIGINAL');
      progress.length = 0;
      cancelAt('t-ow', 5 * 1024 * 1024);
      await assert.rejects(transferService.start('t-ow', { src: L, srcPath: big, dst: { ...R, sessionId: sid }, dstDir: remoteDir, name: 'original.txt', conflict: 'overwrite' }), /Cancelled/);
      assert.strictEqual(fs.readFileSync(target, 'utf-8'), 'ORIGINAL');
      assert.deepStrictEqual(partsIn(remoteDir), []);
    });

    await check('F6 conflictos: sin decision falla (EEXIST), rename = "x (1).ext", overwrite reemplaza / fusiona carpetas, fichero != carpeta', async () => {
      assert.ok(sid, 'sin sesion');
      const src = path.join(localDir, 'informe.txt');
      fs.writeFileSync(src, 'NUEVO');
      fs.writeFileSync(path.join(remoteDir, 'informe.txt'), 'VIEJO');
      const dst = { ...R, sessionId: sid };
      await assert.rejects(transferService.start('c1', { src: L, srcPath: src, dst, dstDir: remoteDir }), /already exists/);
      assert.strictEqual(fs.readFileSync(path.join(remoteDir, 'informe.txt'), 'utf-8'), 'VIEJO');
      const r1 = await transferService.start('c2', { src: L, srcPath: src, dst, dstDir: remoteDir, conflict: 'rename' });
      assert.strictEqual(path.basename(r1.target), 'informe (1).txt');
      const r2 = await transferService.start('c3', { src: L, srcPath: src, dst, dstDir: remoteDir, conflict: 'rename' });
      assert.strictEqual(path.basename(r2.target), 'informe (2).txt');
      await transferService.start('c4', { src: L, srcPath: src, dst, dstDir: remoteDir, conflict: 'overwrite' });
      assert.strictEqual(fs.readFileSync(path.join(remoteDir, 'informe.txt'), 'utf-8'), 'NUEVO');
      // carpeta: fusion
      fs.mkdirSync(path.join(localDir, 'merge'));
      fs.writeFileSync(path.join(localDir, 'merge', 'a.txt'), 'A-nuevo');
      fs.mkdirSync(path.join(remoteDir, 'merge'));
      fs.writeFileSync(path.join(remoteDir, 'merge', 'a.txt'), 'A-viejo');
      fs.writeFileSync(path.join(remoteDir, 'merge', 'solo-remoto.txt'), 'queda');
      await transferService.start('c5', { src: L, srcPath: path.join(localDir, 'merge'), dst, dstDir: remoteDir, conflict: 'overwrite' });
      assert.strictEqual(fs.readFileSync(path.join(remoteDir, 'merge', 'a.txt'), 'utf-8'), 'A-nuevo');
      assert.strictEqual(fs.readFileSync(path.join(remoteDir, 'merge', 'solo-remoto.txt'), 'utf-8'), 'queda');
      // fichero sobre carpeta: nunca
      fs.writeFileSync(path.join(localDir, 'merge-file'), 'x');
      fs.mkdirSync(path.join(remoteDir, 'merge-file'));
      await assert.rejects(transferService.start('c6', { src: L, srcPath: path.join(localDir, 'merge-file'), dst, dstDir: remoteDir, conflict: 'overwrite' }), /folder/);
      assert.ok(fs.statSync(path.join(remoteDir, 'merge-file')).isDirectory());
      // copiar una carpeta dentro de si misma (mismo lado)
      await assert.rejects(transferService.start('c7', { src: dst, srcPath: path.join(remoteDir, 'merge'), dst, dstDir: path.join(remoteDir, 'merge') , conflict: 'rename' }), /itself/);
    });

    await check('F7 remoto -> remoto entre DOS sesiones: en streaming (progreso incremental, memoria acotada) y bytes identicos', async () => {
      assert.ok(sid, 'sin sesion');
      const sid2 = await connect({ label: 'segunda' });
      const destino = path.join(base, 'remote2');
      fs.mkdirSync(destino);
      const enorme = path.join(remoteDir, 'enorme-120MB.bin');
      writeRandom(enorme, 120 * 1024 * 1024);
      progress.length = 0;
      if (global.gc) global.gc();
      const rss0 = process.memoryUsage().rss;
      let rssMax = rss0;
      const timer = setInterval(() => { rssMax = Math.max(rssMax, process.memoryUsage().rss); }, 20);
      try {
        await transferService.start('rr', { src: { ...R, sessionId: sid }, srcPath: enorme, dst: { ...R, sessionId: sid2 }, dstDir: destino });
      } finally {
        clearInterval(timer);
      }
      const ev = progress.filter(p => p.id === 'rr');
      const intermedios = ev.filter(e => e.transferred > 0 && e.transferred < e.total);
      assert.ok(intermedios.length >= 1, 'sin eventos intermedios: no parece streaming');
      assert.strictEqual(sha(path.join(destino, 'enorme-120MB.bin')), sha(enorme));
      const crecio = (rssMax - rss0) / (1024 * 1024);
      // Bufferizar el fichero entero costaria >= 120 MB; por trozos, unas decenas como mucho.
      assert.ok(crecio < 70, `la memoria crecio ${crecio.toFixed(1)} MB copiando 120 MB: se esta bufferizando`);
      const src = fs.readFileSync(path.join(ROOT, 'electron', 'services', 'transfer-service.js'), 'utf-8');
      assert.ok(/_pump\(/.test(src) && /CONCURRENCY = \d+/.test(src) && !/readFile\(|\.fastGet\(|\.fastPut\(/.test(src), 'transfer-service no copia por trozos');
      results50.push(`remoto->remoto 120 MB: ${intermedios.length} eventos intermedios, rss +${crecio.toFixed(1)} MB`);
    });

    await check('F8 un servidor hostil que lista "../x" o "a/b": list() los oculta y una bajada recursiva se para sin escribir fuera', async () => {
      const mkAttrs = (dir) => ({ isDirectory: () => dir, isSymbolicLink: () => false, isFile: () => !dir, size: 3, mode: dir ? 0o40755 : 0o100644, mtime: 0, atime: 0 });
      const fake = {
        readdir: (p, cb) => cb(null, p === '/hostil'
          ? [{ filename: 'ok.txt', attrs: mkAttrs(false) }, { filename: '../escapado.txt', attrs: mkAttrs(false) }, { filename: 'a/b', attrs: mkAttrs(false) }]
          : []),
        lstat: (p, cb) => cb(null, mkAttrs(p === '/hostil')),
        stat: (p, cb) => cb(null, mkAttrs(p === '/hostil')),
        createReadStream: () => { throw new Error('no deberia leer nada'); },
      };
      sftpService.sftpSessions.set('sesion-hostil', fake);
      try {
        const names = (await sftpService.list('sesion-hostil', '/hostil')).map(e => e.name);
        assert.deepStrictEqual(names, ['ok.txt']);
        const dl = path.join(base, 'hostil-dl');
        fs.mkdirSync(dl);
        await assert.rejects(transferService.start('h1', { src: { kind: 'remote', sessionId: 'sesion-hostil' }, srcPath: '/hostil', dst: L, dstDir: dl }), /unsafe name/);
        assert.ok(!fs.existsSync(path.join(base, 'escapado.txt')) && !fs.existsSync(path.join(dl, 'escapado.txt')));
        assert.deepStrictEqual(fs.readdirSync(dl), [], 'se escribio algo antes de pararse');
        await assert.rejects(transferService.start('h2', { src: L, srcPath: big, dst: L, dstDir: dl, name: '../fuera.bin' }), /separator|valid/);
      } finally {
        sftpService.sftpSessions.delete('sesion-hostil');
      }
    });

    await check('F9 editar remoto: baja a temp, abre, cada guardado (incluido escribir+renombrar) avisa una vez, subir actualiza el remoto, cleanup borra el temp', async () => {
      assert.ok(sid, 'sin sesion');
      const remoteFile = path.join(remoteDir, 'notas edit.txt');
      fs.writeFileSync(remoteFile, 'v1\n');
      edits.length = 0;
      opened.length = 0;
      const e = await bridge.sftp.editStart(sid, remoteFile, 'tab-arnes');
      assert.ok(e.editId && e.localPath && e.localPath !== remoteFile);
      assert.deepStrictEqual(opened, [e.localPath]);
      assert.ok(e.localPath.startsWith(os.tmpdir()), 'el temporal no esta en tmpdir');
      assert.strictEqual(fs.readFileSync(e.localPath, 'utf-8'), 'v1\n');
      await sleep(120);
      assert.strictEqual(edits.length, 0, 'aviso sin guardar');
      fs.writeFileSync(e.localPath, 'v2 guardado\n');
      for (let i = 0; i < 60 && edits.length < 1; i++) await sleep(20);
      assert.strictEqual(edits.length, 1, `esperaba 1 aviso, llegaron ${edits.length}`);
      assert.deepStrictEqual([edits[0].editId, edits[0].type, edits[0].owner], [e.editId, 'changed', 'tab-arnes']);
      // Guardado "atomico" como vim/VS Code: escribir otro y renombrar encima
      fs.writeFileSync(`${e.localPath}.swp`, 'v3 atomico\n');
      fs.renameSync(`${e.localPath}.swp`, e.localPath);
      for (let i = 0; i < 60 && edits.length < 2; i++) await sleep(20);
      assert.strictEqual(edits.length, 2, 'el guardado con rename no aviso (watch sobre el inodo viejo)');
      await bridge.sftp.editUpload(e.editId);
      assert.strictEqual(fs.readFileSync(remoteFile, 'utf-8'), 'v3 atomico\n');
      await sleep(150);
      assert.strictEqual(edits.length, 2, 'subir provoco otro aviso');
      const tmpRoot = editService.ownerDirs.get('tab-arnes');
      assert.ok(tmpRoot && fs.existsSync(tmpRoot));
      await bridge.sftp.cleanup('tab-arnes');
      assert.ok(!fs.existsSync(tmpRoot), 'cleanup no borro el temporal');
      assert.ok(!editService.edits.has(e.editId));
      await assert.rejects(bridge.sftp.editUpload(e.editId), /no longer open/);
      await assert.rejects(bridge.sftp.cleanup('../x'), /owner/);
    });

    await check('F10 abrir remoto: baja a temp y shell.openPath; al salir (closeAllSync) no queda nada en tmp', async () => {
      assert.ok(sid, 'sin sesion');
      opened.length = 0;
      const r = await bridge.sftp.openRemote(sid, path.join(remoteDir, 'suelto.bin'), 'tab-open');
      assert.deepStrictEqual(opened, [r.localPath]);
      assert.strictEqual(sha(r.localPath), sha(path.join(remoteDir, 'suelto.bin')));
      const dir = editService.ownerDirs.get('tab-open');
      editService.closeAllSync();
      assert.ok(!fs.existsSync(dir));
      const bq = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf-8');
      assert.ok(/sftpEditService\.closeAllSync\(\)/.test(bq) && /transferService\.cancelAll\(\)/.test(bq), 'before-quit no limpia SFTP');
    });

    await check('F11 SFTP sobre la sesion de una TERMINAL (reutilizada): funciona, y ssh:disconnect cierra tambien el canal SFTP', async () => {
      assert.ok(sshd, 'sin sshd');
      const term = await connect({ purpose: undefined, label: 'terminal' });
      assert.ok(sshService.sessions.get(term).stream, 'la terminal no tiene shell');
      const names = (await bridge.sftp.list(term, remoteDir)).map(e => e.name);
      assert.ok(names.includes('suelto.bin'));
      assert.ok(sftpService.sftpSessions.has(term));
      await bridge.ssh.disconnect(term);
      assert.ok(!sftpService.sftpSessions.has(term), 'el canal SFTP sobrevivio a la desconexion');
      await assert.rejects(bridge.sftp.list(term, remoteDir), /closed/);
    });

    await check('F12 permiso denegado: el error dice "Permission denied" con la ruta', async () => {
      assert.ok(sid, 'sin sesion');
      const locked = path.join(remoteDir, 'cerrada');
      fs.mkdirSync(locked, { mode: 0o000 });
      try {
        await assert.rejects(bridge.sftp.list(sid, locked), /Permission denied: .*cerrada/);
        await assert.rejects(localFs.list(locked), /Permission denied/);
      } finally {
        fs.chmodSync(locked, 0o755);
      }
    });

    if (results50.length) console.log(`[arnes F] ${results50.join(' · ')}`);
  } finally {
    for (const id of sessions) await sshService.disconnect(id).catch(() => {});
    if (sshd) await sshd.stop();
    hostKeyService.setMainWindow(ventanaHk);
    transferService.setMainWindow(ventanaTr);
    editService.setMainWindow(ventanaEd);
    if (agente) process.env.SSH_AUTH_SOCK = agente;
    localFs._shell = null;
    editService._shell = null;
    editService.debounceMs = 300;
    await storeService.writeRaw('known-hosts', []);
    await storeService.writeRaw('connection-logs', []);
    try { fs.chmodSync(path.join(remoteDir, 'cerrada'), 0o755); } catch (_) { /* no existe */ }
    await fsp.rm(base, { recursive: true, force: true });
  }
}

module.exports = { seccionSftp };
