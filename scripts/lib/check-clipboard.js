/**
 * Seccion C del arnes del main (scripts/check-main.js): copiar y pegar en la
 * terminal.
 *
 *  C1  canales clipboard:* por el preload de verdad contra un `clipboard` de
 *      Electron falso: texto, PRIMARY (solo Linux), solo-PRIMARY, imagen como
 *      bytes PNG, has-image por formato o por imagen, null sin imagen.
 *  C2  chunked-writer: 200 lineas llegan enteras y en orden, trozos <= 1024,
 *      nunca medio par sustituto, lo tecleado despues va DETRAS de la pegada,
 *      lo corto sin cola sale al instante.
 *  C3  backpressure: write() false espera 'drain'; sin 'drain' no se atasca.
 *  C4  ssh-service.sendData y local-shell-service.write pasan por el writer
 *      (canal ssh2 falso que devuelve false y emite drain; pty falso).
 *  C5  la costura del renderer, src/components/Terminal/clipboardPaste.js
 *      (empaquetada con esbuild): texto gana a imagen, imagen -> onImage con
 *      Uint8Array, nada -> nada, CRLF/CR, marcadores de bracketed paste
 *      quitados, confirmacion solo sin bracketed paste y con salto de linea,
 *      cancelar no pega, 'selection' lee PRIMARY, copiar recorta espacios
 *      finales por linea y escribe clipboard + selection.
 *  C6  de verdad (Linux, Electron-como-node): 200 lineas por un pty real hasta
 *      `wc -lc`, por el writer troceado y de un golpe (scripts/lib/paste-driver.js).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { execFile } = require('child_process');

/** `clipboard` de Electron falso, en memoria (lo usa el stub de check-main) */
function makeFakeClipboard() {
  const st = { clipboard: '', selection: '', image: null, formats: [] };
  const img = (png) => ({ isEmpty: () => !png, toPNG: () => Buffer.from(png || []) });
  return {
    _state: st,
    readText: (type = 'clipboard') => st[type === 'selection' ? 'selection' : 'clipboard'],
    writeText: (text, type = 'clipboard') => { st[type === 'selection' ? 'selection' : 'clipboard'] = text; st.formats = ['text/plain']; },
    readImage: () => img(st.image),
    availableFormats: () => st.formats.slice(),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function seccionClipboard({ check, ROOT, handlers, getBridge, fakeClipboard }) {
  const st = fakeClipboard._state;
  const reset = () => { st.clipboard = ''; st.selection = ''; st.image = null; st.formats = []; };

  await check('C1 clipboard:* por el preload: texto, PRIMARY (Linux), solo-PRIMARY, imagen PNG, has-image, null sin imagen', async () => {
    for (const ch of ['clipboard:read-text', 'clipboard:write-text', 'clipboard:has-image', 'clipboard:read-image']) {
      assert.ok(handlers.has(ch), `falta el handler ${ch}`);
    }
    const bridge = getBridge();
    assert.ok(bridge && bridge.clipboard, 'preload no expone clipboard');
    const c = bridge.clipboard;
    reset();
    await c.writeText('hola\nmundo');
    assert.strictEqual(st.clipboard, 'hola\nmundo');
    assert.strictEqual(st.selection, '', 'sin selection:true no se toca PRIMARY');
    assert.strictEqual(await c.readText(), 'hola\nmundo');
    await c.writeText('sel', { selection: true });
    const linux = process.platform === 'linux';
    assert.strictEqual(st.selection, linux ? 'sel' : '', 'PRIMARY solo en Linux');
    assert.strictEqual(await c.readText('selection'), 'sel', 'selection lee PRIMARY (Linux) o el clipboard (resto)');
    reset();
    await c.writeText('solo-primary', { clipboard: false, selection: true });
    assert.strictEqual(st.clipboard, '', 'clipboard:false no debe tocar el portapapeles');
    if (linux) assert.strictEqual(st.selection, 'solo-primary');
    await assert.rejects(() => c.writeText(42), /string/, 'un no-string debe rechazar');
    reset();
    assert.strictEqual(await c.hasImage(), false);
    assert.strictEqual(await c.readImage(), null);
    st.image = [0x89, 0x50, 0x4e, 0x47, 1, 2, 3];
    assert.strictEqual(await c.hasImage(), true, 'imagen sin formato image/* listado igual cuenta');
    st.formats = ['image/png'];
    assert.strictEqual(await c.hasImage(), true);
    const r = await c.readImage();
    assert.strictEqual(r.mime, 'image/png');
    assert.ok(r.png instanceof Uint8Array, 'png debe ser bytes (Buffer/Uint8Array)');
    assert.deepStrictEqual([...r.png], st.image);
    reset();
  });

  const { createChunkedWriter, slice, CHUNK } = require(path.join(ROOT, 'electron', 'services', 'chunked-writer.js'));
  const lines = [];
  for (let i = 0; i < 200; i++) lines.push(`l${i} ñ 😀 ${'y'.repeat(150 + (i % 50))}`);
  const big = lines.join('\r') + '\r';

  await check('C2 chunked-writer: 200 lineas enteras y en orden, trozos <= 1024 sin partir pares sustitutos, lo tecleado va detras, lo corto sale ya', async () => {
    const got = [];
    const w = createChunkedWriter((c) => { got.push(c); return true; });
    w.write('a');
    assert.deepStrictEqual(got, ['a'], 'una tecla sin cola debe salir sincrona');
    w.write(big);
    w.write('TECLA');
    assert.ok(w.pending() > 0, 'una pegada grande no sale de un golpe');
    for (let i = 0; i < 400 && w.pending(); i++) await sleep(5);
    await sleep(10);
    assert.strictEqual(w.pending(), 0);
    assert.strictEqual(got.join(''), 'a' + big + 'TECLA', 'bytes perdidos o desordenados');
    assert.strictEqual(got[got.length - 1], 'TECLA', 'lo tecleado durante la pegada adelanto a la pegada');
    for (const c of got) {
      assert.ok(c.length <= CHUNK, `trozo de ${c.length}`);
      const last = c.charCodeAt(c.length - 1);
      assert.ok(!(last >= 0xd800 && last <= 0xdbff), 'un trozo termina en medio par sustituto');
    }
    assert.deepStrictEqual(slice('ab😀', 3), ['ab', '😀'], 'slice parte un emoji');
    const d = createChunkedWriter(() => true);
    d.write(big); d.dispose();
    assert.strictEqual(d.pending(), 0);
  });

  await check('C3 backpressure: write()=false espera drain; si drain no llega, sigue igual (fallback)', async () => {
    const em = new EventEmitter();
    const got = [];
    let full = true;
    const w = createChunkedWriter((c) => { got.push(c); return !full; }, { waitDrain: (cb) => em.once('drain', cb) });
    w.write('x'.repeat(3000));
    assert.strictEqual(got.length, 1);
    await sleep(30);
    assert.strictEqual(got.length, 1, 'no debe seguir escribiendo con el canal lleno');
    full = false;
    em.emit('drain');
    await sleep(40);
    assert.strictEqual(got.join('').length, 3000);
    const got2 = [];
    const w2 = createChunkedWriter((c) => { got2.push(c); return false; }, { waitDrain: () => {} });
    w2.write('z'.repeat(2100));
    await sleep(2400);
    assert.strictEqual(got2.join('').length, 2100, 'sin drain el writer se quedo atascado');
  });

  await check('C4 ssh-service.sendData y local-shell-service.write van troceados y en orden (canal ssh2 falso con drain, pty falso)', async () => {
    const ssh = require(path.join(ROOT, 'electron', 'services', 'ssh-service.js'));
    const stream = new EventEmitter();
    const recibido = [];
    let n = 0;
    stream.write = (c) => { recibido.push(c); n++; if (n % 3 === 0) { setTimeout(() => stream.emit('drain'), 2); return false; } return true; };
    stream.setWindow = () => {};
    const sid = 'arnes-c4-ssh';
    ssh.sessions.set(sid, { client: new EventEmitter(), stream, config: {}, logId: null });
    ssh.sendData(sid, big);
    ssh.sendData(sid, '\x03');
    for (let i = 0; i < 400 && recibido.join('').length < big.length + 1; i++) await sleep(5);
    assert.strictEqual(recibido.join(''), big + '\x03', 'ssh: bytes perdidos o desordenados');
    assert.ok(recibido.length > 10, 'ssh: la pegada salio de un golpe');
    ssh._cleanup(sid);

    const local = require(path.join(ROOT, 'electron', 'services', 'local-shell-service.js'));
    const pty = { got: [], write(c) { this.got.push(c); } };
    const lsid = 'arnes-c4-local';
    local.shells.set(lsid, pty);
    local.write(lsid, big);
    local.write(lsid, 'q');
    for (let i = 0; i < 400 && pty.got.join('').length < big.length + 1; i++) await sleep(5);
    assert.strictEqual(pty.got.join(''), big + 'q', 'pty: bytes perdidos o desordenados');
    assert.ok(pty.got.length > 10, 'pty: la pegada salio de un golpe');
    local.shells.delete(lsid);
    local._dropWriter(lsid);
  });

  // ── C5: la costura del renderer ──
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termilab-clip-'));
  const out = path.join(tmp, 'clipboardPaste.cjs');
  let seam = null;
  let motivo = null;
  try {
    require(path.join(ROOT, 'node_modules', 'esbuild')).buildSync({
      entryPoints: [path.join(ROOT, 'src', 'components', 'Terminal', 'clipboardPaste.js')],
      bundle: true, format: 'cjs', platform: 'node', outfile: out, logLevel: 'silent',
    });
    seam = require(out);
  } catch (err) { motivo = err.message; }

  await check('C5 clipboardPaste.js: texto gana, imagen -> onImage(Uint8Array), CRLF, sin marcadores 200~/201~, confirmar solo sin bracketed paste, PRIMARY, copiar recorta', async () => {
    assert.ok(seam, `no se pudo empaquetar clipboardPaste.js: ${motivo}`);
    reset();
    global.window = { electronAPI: getBridge() };
    const mkTerm = (bracketed = false) => ({
      modes: { bracketedPasteMode: bracketed },
      pasted: [],
      paste(t) { this.pasted.push(t); },
    });
    try {
      // texto
      st.clipboard = 'echo uno\r\necho dos\rfin';
      let t = mkTerm(true);
      let imgs = 0;
      let r = await seam.pasteInto(t, { onImage: () => { imgs++; } });
      assert.strictEqual(r.kind, 'text');
      assert.deepStrictEqual(t.pasted, ['echo uno\necho dos\nfin'], 'CRLF/CR no normalizados');
      // texto + imagen: gana el texto
      st.image = [1, 2, 3]; st.formats = ['text/plain', 'image/png'];
      t = mkTerm(true);
      r = await seam.pasteInto(t, { onImage: () => { imgs++; } });
      assert.strictEqual(r.kind, 'text'); assert.strictEqual(imgs, 0, 'con texto no debe llamar a onImage');
      // solo imagen
      st.clipboard = '';
      t = mkTerm(true);
      let img = null;
      r = await seam.pasteInto(t, { onImage: (i) => { img = i; } });
      assert.strictEqual(r.kind, 'image');
      assert.ok(img && img.png instanceof Uint8Array && img.mime === 'image/png');
      assert.deepStrictEqual([...img.png], [1, 2, 3]);
      assert.deepStrictEqual(t.pasted, []);
      // imagen sin onImage: nada
      r = await seam.pasteInto(t, {});
      assert.strictEqual(r.kind, 'empty'); assert.deepStrictEqual(t.pasted, []);
      // vacio
      reset();
      r = await seam.pasteInto(t, { onImage: () => { imgs++; } });
      assert.strictEqual(r.kind, 'empty'); assert.strictEqual(imgs, 0);
      // inyeccion de fin de bracketed paste
      st.clipboard = 'inocente\x1b[201~rm -rf ~\x1b[200~';
      t = mkTerm(true);
      await seam.pasteInto(t, {});
      assert.deepStrictEqual(t.pasted, ['inocenterm -rf ~'], 'los marcadores de bracketed paste cruzaron');
      // confirmacion
      st.clipboard = 'a\nb\nc\n';
      let asked = null;
      t = mkTerm(false);
      r = await seam.pasteInto(t, { confirm: (info) => { asked = info; return Promise.resolve(false); } });
      assert.strictEqual(r.kind, 'cancelled'); assert.deepStrictEqual(t.pasted, [], 'cancelar pego igual');
      assert.strictEqual(asked.lines, 3, 'cuenta de lineas (el salto final no suma)');
      t = mkTerm(false);
      r = await seam.pasteInto(t, { confirm: () => Promise.resolve(true) });
      assert.deepStrictEqual(t.pasted, ['a\nb\nc\n']);
      asked = null;
      t = mkTerm(true);
      await seam.pasteInto(t, { confirm: (i) => { asked = i; return Promise.resolve(false); } });
      assert.strictEqual(asked, null, 'con bracketed paste no hay que preguntar');
      assert.deepStrictEqual(t.pasted, ['a\nb\nc\n']);
      st.clipboard = 'una sola linea';
      t = mkTerm(false);
      await seam.pasteInto(t, { confirm: (i) => { asked = i; return Promise.resolve(false); } });
      assert.strictEqual(asked, null, 'una linea sin salto no pregunta');
      // paste propio (Android: inject)
      let via = null;
      await seam.pasteInto(mkTerm(true), { paste: (x) => { via = x; } });
      assert.strictEqual(via, 'una sola linea');
      // PRIMARY
      if (process.platform === 'linux') {
        st.selection = 'desde primary';
        t = mkTerm(true);
        await seam.pasteInto(t, { source: 'selection', onImage: () => { imgs++; } });
        assert.deepStrictEqual(t.pasted, ['desde primary']);
        st.selection = '';
        st.image = [9];
        await seam.pasteInto(t, { source: 'selection', onImage: () => { imgs++; } });
        assert.strictEqual(imgs, 0, 'el clic central no pega imagenes');
      }
      // copiar
      reset();
      const sel = { hasSelection: () => true, getSelection: () => 'uno   \ndos con  espacio  \ntres' };
      const c = await seam.copySelection(sel);
      assert.strictEqual(c.text, 'uno\ndos con  espacio\ntres', 'recorte de espacios finales');
      assert.strictEqual(c.copied, true);
      assert.strictEqual(st.clipboard, 'uno\ndos con  espacio\ntres');
      if (process.platform === 'linux') assert.strictEqual(st.selection, 'uno\ndos con  espacio\ntres');
      reset();
      const p = await seam.copySelection(sel, { clipboard: false, selection: true });
      assert.strictEqual(p.copied, false); assert.strictEqual(st.clipboard, '', 'solo-PRIMARY toco el portapapeles');
      const none = await seam.copySelection({ hasSelection: () => false, getSelection: () => '' });
      assert.strictEqual(none.text, '');
    } finally {
      delete global.window;
      reset();
    }
  });
  fs.rmSync(tmp, { recursive: true, force: true });

  // ── C6: de verdad ──
  const electronBin = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron');
  if (process.platform !== 'linux' || !fs.existsSync(electronBin)) {
    await check('C6 200 lineas por un pty real hasta wc -lc -- OMITIDA: no es Linux o falta node_modules/electron', () => {});
    return;
  }
  await check('C6 200 lineas (multibyte, CR como xterm) por un pty real hasta `wc -lc`: troceado y directo, sin perder un byte', async () => {
    const r = await new Promise((resolve, reject) => {
      execFile(electronBin, [path.join(__dirname, 'paste-driver.js'), ROOT],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 60000 },
        (err, stdout, stderr) => {
          const line = String(stdout).trim().split('\n').filter((l) => l.startsWith('{')).pop();
          if (!line) return reject(new Error(`el driver no devolvio nada: ${err && err.message} ${String(stderr).slice(-300)}`));
          resolve(JSON.parse(line));
        });
    });
    for (const k of ['chunked', 'direct']) {
      assert.ok(!r[k].error, `${k}: ${r[k].error} ${r[k].out || ''}`);
      assert.strictEqual(r[k].lines, r.expectedLines, `${k}: wc -l = ${r[k].lines}`);
      assert.strictEqual(r[k].bytes, r.expectedBytes, `${k}: wc -c = ${r[k].bytes}`);
    }
  });
}

module.exports = { seccionClipboard, makeFakeClipboard };
