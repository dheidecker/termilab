/**
 * Seccion UP del arnes del main (scripts/check-main.js): imagenes a una
 * terminal (arrastrar y soltar / portapapeles), electron/services/upload-service.js.
 *
 *  UP1  sniff + nombres saneados (espacios, unicode, "../", vacio).
 *  UP2  local: guarda en <home>/.termilab/uploads, dir 0700, fichero 0600.
 *  UP3  local: no-imagen, > 20 MB y > 10 elementos se niegan sin escribir nada.
 *  UP4  local: limpieza borra solo lo de > 3 dias (ni carpetas ni lo reciente).
 *  UP5  local: uploads como symlink se niega.
 *  UP6  remoto (sshd real, HOME temporal): por el handler IPC attach:upload,
 *       en orden, 0600, ruta absoluta, mismo contenido, progreso al sender,
 *       y sobre la MISMA conexion (ningun cliente ssh2 nuevo).
 *  UP7  remoto: no-imagen y tamano se niegan sin crear nada.
 *  UP8  remoto: limpieza de > 3 dias solo.
 *  UP9  remoto: uploads como symlink se niega (y no se escribe a traves).
 *  UP10 renderer (imageAttach.js con esbuild): comillas de shell, negativas,
 *       y TerminalView solo reacciona a arrastres 'Files' sin DRAG_MIME.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { startRealSshd } = require('./real-sshd');

const SFTP_SERVERS = ['/usr/lib/openssh/sftp-server', '/usr/libexec/openssh/sftp-server', '/usr/lib/ssh/sftp-server', '/usr/libexec/sftp-server'];

/** A real (tiny) PNG of w x h, padded with a tEXt chunk up to ~`pad` bytes. */
function png(w = 2, h = 2, pad = 0) {
  const crcTable = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw))];
  if (pad) parts.push(chunk('tEXt', Buffer.concat([Buffer.from('pad\0'), Buffer.alloc(pad, 0x61)])));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

const mode = (p) => fs.lstatSync(p).mode & 0o777;
const old = (p, days) => { const t = Date.now() / 1000 - days * 86400; fs.utimesSync(p, t, t); };

async function seccionAttach({ check, ROOT, handlers }) {
  const svc = (n) => require(path.join(ROOT, 'electron', 'services', n));
  const up = svc('upload-service.js');
  const sshService = svc('ssh-service.js');
  const hostKeyService = svc('host-key-service.js');
  const storeService = svc('store-service.js');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termilab-up-'));
  const localHome = path.join(tmp, 'local-home');
  fs.mkdirSync(localHome, { mode: 0o700 });
  up.localHome = localHome;
  const upDir = path.join(localHome, '.termilab', 'uploads');
  const img = png(4, 4);

  try {
    await check('UP1 sniff de imagenes y nombres saneados (espacios, unicode, ../)', () => {
      assert.strictEqual(up.sniff(img), 'png');
      assert.strictEqual(up.sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'jpg');
      assert.strictEqual(up.sniff(Buffer.from('GIF89a......')), 'gif');
      assert.strictEqual(up.sniff(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'webp');
      assert.strictEqual(up.sniff(Buffer.from('#!/bin/sh\necho hi\n')), null);
      const when = new Date(2026, 9, 14, 9, 5, 7);
      const ok = /^[A-Za-z0-9][A-Za-z0-9._-]*-20261014-090507(-\d+)?\.png$/;
      const cases = {
        'captura de pantalla.png': 'captura-de-pantalla-20261014-090507.png',
        'ñandú año.png': 'nandu-ano-20261014-090507.png',
        '../../etc/passwd': 'passwd-20261014-090507.png',
        '..\\..\\win.png': 'win-20261014-090507.png',
        '日本語 🚀.png': 'image-20261014-090507.png',
        '.hidden.png': 'hidden-20261014-090507.png',
        "it's $(id) `x`.png": 'it-s-id-x-20261014-090507.png',
        '': 'image-20261014-090507.png',
      };
      for (const [name, want] of Object.entries(cases)) {
        const got = up.safeName(name, 'png', when);
        assert.strictEqual(got, want, `${JSON.stringify(name)} → ${got}`);
        assert.ok(ok.test(got) && !got.includes('/') && !got.includes('..'), got);
      }
      assert.strictEqual(up.safeName('a.png', 'png', when, 1), 'a-20261014-090507-2.png');
    });

    await check('UP2 local: guarda en ~/.termilab/uploads (dir 0700, fichero 0600) y devuelve rutas absolutas en orden', async () => {
      const paths = await up.saveLocal([{ data: new Uint8Array(img), name: 'clip.png' }, { data: img, name: 'otra imagen.png' }]);
      assert.strictEqual(paths.length, 2);
      assert.ok(/\/clip-\d{8}-\d{6}\.png$/.test(paths[0]), paths[0]);
      assert.ok(/\/otra-imagen-\d{8}-\d{6}\.png$/.test(paths[1]), paths[1]);
      for (const p of paths) {
        assert.ok(path.isAbsolute(p) && path.dirname(p) === upDir, p);
        assert.strictEqual(mode(p), 0o600, `modo ${mode(p).toString(8)}`);
        assert.ok(fs.readFileSync(p).equals(img));
      }
      assert.strictEqual(mode(upDir), 0o700);
      assert.strictEqual(mode(path.dirname(upDir)), 0o700);
      // Mismo nombre en el mismo segundo: no pisa
      const again = await up.saveLocal([{ data: img, name: 'clip.png' }, { data: img, name: 'clip.png' }]);
      assert.strictEqual(new Set([...again, paths[0]]).size, 3, again.join(' '));
    });

    await check('UP3 local: no-imagen, > 20 MB y > 10 se niegan sin escribir nada', async () => {
      const before = fs.readdirSync(upDir).length;
      await assert.rejects(up.saveLocal([{ data: Buffer.from('#!/bin/sh\nrm -rf ~\n'), name: 'evil.png' }]), /Only images can be attached/);
      await assert.rejects(up.saveLocal([{ data: img, name: 'ok.png' }, { data: Buffer.from('hola'), name: 'x.txt' }]), /Only images/);
      await assert.rejects(up.saveLocal([{ data: png(1, 1, 20 * 1024 * 1024 + 10), name: 'big.png' }]), /larger than 20 MB/);
      await assert.rejects(up.saveLocal(Array.from({ length: 11 }, () => ({ data: img, name: 'a.png' }))), /At most 10/);
      // Por ruta: un ejecutable renombrado a .png tampoco pasa
      const fake = path.join(tmp, 'fake.png');
      fs.writeFileSync(fake, '\x7fELF....');
      await assert.rejects(up.saveLocal([{ path: fake }]), /Only images/);
      assert.strictEqual(fs.readdirSync(upDir).length, before, 'escribio algo');
    });

    await check('UP4 local: la limpieza borra solo lo de mas de 3 dias', async () => {
      const viejo = path.join(upDir, 'viejo.png'); fs.writeFileSync(viejo, img); old(viejo, 4);
      const reciente = path.join(upDir, 'reciente.png'); fs.writeFileSync(reciente, img); old(reciente, 2);
      const sub = path.join(upDir, 'carpeta'); fs.mkdirSync(sub); old(sub, 9);
      const fuera = path.join(tmp, 'fuera.png'); fs.writeFileSync(fuera, img); old(fuera, 9);
      const enlace = path.join(upDir, 'enlace.png'); fs.symlinkSync(fuera, enlace);
      const t = Date.now() / 1000 - 5 * 86400;
      fs.lutimesSync(enlace, t, t);
      await up.saveLocal([{ data: img, name: 'nueva.png' }]);
      assert.ok(!fs.existsSync(viejo), 'no borro el de 4 dias');
      assert.ok(fs.existsSync(reciente), 'borro el de 2 dias');
      assert.ok(fs.existsSync(sub), 'borro una carpeta');
      assert.ok(fs.existsSync(fuera), 'siguio un enlace y borro su destino');
      assert.ok(!fs.existsSync(enlace) && !fs.lstatSync(path.dirname(enlace)).isSymbolicLink());
      fs.rmdirSync(sub);
    });

    await check('UP5 local: uploads como symlink se niega', async () => {
      const otraHome = path.join(tmp, 'h2');
      const destino = path.join(tmp, 'destino');
      fs.mkdirSync(path.join(otraHome, '.termilab'), { recursive: true, mode: 0o700 });
      fs.mkdirSync(destino, { mode: 0o700 });
      fs.symlinkSync(destino, path.join(otraHome, '.termilab', 'uploads'));
      up.localHome = otraHome;
      try {
        await assert.rejects(up.saveLocal([{ data: img, name: 'a.png' }]), /symlink/);
        assert.deepStrictEqual(fs.readdirSync(destino), []);
      } finally { up.localHome = localHome; }
    });

    /* ── remoto: sshd de verdad con HOME en un temporal ── */
    const home = path.join(tmp, 'remote-home');
    fs.mkdirSync(home, { mode: 0o700 });
    const sftpServer = SFTP_SERVERS.find(p => fs.existsSync(p)) || '/usr/lib/openssh/sftp-server';
    const wrapper = path.join(tmp, 'wrap.sh');
    fs.writeFileSync(wrapper, [
      '#!/bin/sh',
      `HOME='${home}'; export HOME`,
      'cd "$HOME" || exit 1',
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
      await check(`UP6-UP9 OMITIDAS: no se pudo arrancar sshd (${sinSshd})`, () => {});
    } else {
      const ventanaHk = hostKeyService.mainWindow;
      hostKeyService.setMainWindow({
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send: (canal, d) => { if (canal === 'ssh:host-key-prompt') setTimeout(() => hostKeyService.respond(d.requestId, true), 5); } },
      });
      const agente = process.env.SSH_AUTH_SOCK;
      delete process.env.SSH_AUTH_SOCK;
      let sid = null;
      const rUp = path.join(home, '.termilab', 'uploads');
      try {
        await storeService.writeRaw('known-hosts', []);
        sid = await sshService.connect({
          host: '127.0.0.1', port: sshd.port, username: sshd.user, privateKey: sshd.privateKey,
          label: 'sshd del arnes', hostId: 'h-up', purpose: 'sftp', timeout: 8000,
        });
        const client = sshService.getClient(sid);
        const pushes = [];
        const sender = { isDestroyed: () => false, send: (c, d) => { if (c === 'attach:progress') pushes.push(d); } };
        const call = async (...args) => {
          const r = await handlers.get('attach:upload')({ sender }, ...args);
          if (!r.success) throw new Error(r.error);
          return r.data;
        };

        await check('UP6 remoto: por attach:upload, en orden, 0600, ruta absoluta, mismo contenido, misma conexion', async () => {
          const local = path.join(tmp, 'captura de pantalla.png');
          const big = png(8, 8, 3 * 1024 * 1024);
          fs.writeFileSync(local, big);
          const conexiones = sshService.sessions.size;
          up.progressMs = 0;
          const paths = await call(sid, 'u1', [{ path: local }, { data: new Uint8Array(img), name: '../../clip.png' }]);
          up.progressMs = 100;
          assert.strictEqual(paths.length, 2);
          assert.ok(/^\/.*\/\.termilab\/uploads\/captura-de-pantalla-\d{8}-\d{6}\.png$/.test(paths[0]), paths[0]);
          assert.ok(/\/\.termilab\/uploads\/clip-\d{8}-\d{6}\.png$/.test(paths[1]), paths[1]);
          for (const p of paths) assert.strictEqual(path.dirname(p), fs.realpathSync(rUp), p);
          assert.ok(fs.readFileSync(paths[0]).equals(big), 'contenido distinto');
          assert.ok(fs.readFileSync(paths[1]).equals(img));
          for (const p of paths) assert.strictEqual(mode(p), 0o600, `${p} ${mode(p).toString(8)}`);
          assert.strictEqual(mode(rUp), 0o700);
          assert.strictEqual(sshService.sessions.size, conexiones, 'abrio otra sesion');
          assert.strictEqual(sshService.getClient(sid), client, 'cambio el cliente ssh2');
          const mine = pushes.filter(p => p.uploadId === 'u1');
          assert.ok(mine.some(p => p.index === 0 && p.sent > 0 && p.sent < p.total), 'sin progreso intermedio');
          assert.ok(mine.some(p => p.index === 1 && p.done), 'sin fin del segundo');
        });

        await check('UP7 remoto: no-imagen y > 20 MB se niegan sin crear nada', async () => {
          const before = fs.readdirSync(rUp).length;
          await assert.rejects(call(sid, 'u2', [{ data: Buffer.from('#!/bin/sh\n'), name: 'x.png' }]), /Only images can be attached/);
          await assert.rejects(call(sid, 'u3', [{ data: png(1, 1, 20 * 1024 * 1024 + 1), name: 'big.png' }]), /larger than 20 MB/);
          assert.strictEqual(fs.readdirSync(rUp).length, before);
          assert.ok(!pushes.some(p => p.uploadId === 'u2' || p.uploadId === 'u3'), 'empujo progreso de algo negado');
        });

        await check('UP8 remoto: la limpieza borra solo lo de mas de 3 dias', async () => {
          const viejo = path.join(rUp, 'viejo.png'); fs.writeFileSync(viejo, img); old(viejo, 3.5);
          const reciente = path.join(rUp, 'reciente.png'); fs.writeFileSync(reciente, img); old(reciente, 2.5);
          const sub = path.join(rUp, 'sub'); fs.mkdirSync(sub); old(sub, 10);
          await call(sid, 'u4', [{ data: img, name: 'n.png' }]);
          assert.ok(!fs.existsSync(viejo), 'no borro el viejo');
          assert.ok(fs.existsSync(reciente) && fs.existsSync(sub), 'borro de mas');
        });

        await check('UP9 remoto: ~/.termilab/uploads como symlink se niega y no se escribe a traves', async () => {
          const destino = path.join(tmp, 'remote-destino');
          fs.mkdirSync(destino, { mode: 0o700 });
          fs.renameSync(rUp, `${rUp}.real`);
          fs.symlinkSync(destino, rUp);
          try {
            await assert.rejects(call(sid, 'u5', [{ data: img, name: 'a.png' }]), /symlink/);
            assert.deepStrictEqual(fs.readdirSync(destino), []);
          } finally {
            fs.unlinkSync(rUp);
            fs.renameSync(`${rUp}.real`, rUp);
          }
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

    await check('UP10 renderer: comillas de shell, negativas y solo arrastres de ficheros', () => {
      const out = path.join(tmp, 'ia.cjs');
      execFileSync(path.join(ROOT, 'node_modules', '.bin', 'esbuild'), [
        path.join(ROOT, 'src', 'components', 'Terminal', 'imageAttach.js'),
        '--bundle', '--platform=node', '--format=cjs', `--outfile=${out}`, '--log-level=error',
      ], { stdio: 'pipe' });
      const ia = require(out);
      assert.strictEqual(ia.shellQuote('/home/u/.termilab/uploads/a-20261014-090507.png'), '/home/u/.termilab/uploads/a-20261014-090507.png');
      assert.strictEqual(ia.shellQuote('/tmp/my shots/it\'s.png'), `'/tmp/my shots/it'\\''s.png'`);
      assert.strictEqual(ia.shellQuote('/tmp/$(id).png'), `'/tmp/$(id).png'`);
      const it = (name, size = 10) => ({ name, size, mime: '' });
      assert.strictEqual(ia.refusal([it('a.PNG'), it('b.jpeg'), it('c.webp'), it('d.gif')]), null);
      assert.strictEqual(ia.refusal([it('a.png'), it('notes.txt')]), 'Only images can be attached');
      assert.match(ia.refusal([it('a.png', 21 * 1024 * 1024)]), /larger than 20 MB/);
      assert.match(ia.refusal(Array.from({ length: 11 }, () => it('a.png'))), /At most 10/);
      const dt = (...types) => ({ dataTransfer: { types } });
      assert.strictEqual(ia.isFilesDrag(dt('Files')), true);
      assert.strictEqual(ia.isFilesDrag(dt('application/x-termilab-pane', 'text/plain')), false);
      assert.strictEqual(ia.isFilesDrag(dt('Files', 'application/x-termilab-pane')), false);
      assert.strictEqual(ia.isFilesDrag(dt('text/plain')), false);
      const tv = fs.readFileSync(path.join(ROOT, 'src', 'components', 'Terminal', 'TerminalView.jsx'), 'utf-8');
      assert.ok(/onDrop:[\s\S]{0,80}isFilesDrag\(e\)/.test(tv), 'el drop de TerminalView no filtra por isFilesDrag');
      const src = fs.readFileSync(path.join(ROOT, 'src', 'components', 'Terminal', 'imageAttach.js'), 'utf-8');
      assert.ok(/term\.paste\(/.test(src) && !/\\r['"`]/.test(src), 'imageAttach tiene que escribir con term.paste y sin Enter');
    });
  } finally {
    up.localHome = null;
    up.progressMs = 100;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { seccionAttach, png };
