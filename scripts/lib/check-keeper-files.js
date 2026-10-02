/**
 * Seccion KB del arnes del main (scripts/check-main.js): los binarios de
 * termilab-keeper que viajan dentro de cada paquete (electron/keeper/bin/).
 *
 *  KB1 cada entrada de manifest.json existe, con su size y su sha256; kv
 *      coincide con KEEPER_VERSION de keeper.h; el nombre es
 *      termilab-keeper-<kv>-<arch>; no hay en bin/ nada que el manifest no liste.
 *  KB2 cada binario es ELF estatico (sin PT_INTERP ni PT_DYNAMIC) de la
 *      arquitectura declarada (EI_CLASS, little-endian, e_machine; armv7l
 *      ademas EABI5 hard-float).
 *  KB3 scripts/build-keeper.sh fija la version de Zig (ZIG_VERSION) y el
 *      README dice la misma; si hay zig a mano, es esa.
 *  KB4 empaquetado: `files` de electron-builder deja fuera src/ y test/, y
 *      existe `npm run keeper:build`.
 *
 * Tambien se corre suelto: node scripts/lib/check-keeper-files.js
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// arch (uname -m) -> lo que tiene que decir la cabecera ELF
const ARCHS = {
  x86_64:  { cls: 2, machine: 62 },   // EM_X86_64
  aarch64: { cls: 2, machine: 183 },  // EM_AARCH64
  armv7l:  { cls: 1, machine: 40 },   // EM_ARM
  riscv64: { cls: 2, machine: 243 },  // EM_RISCV
};
const PT_DYNAMIC = 2;
const PT_INTERP = 3;

function leeElf(buf) {
  assert.ok(buf.length >= 52 && buf.readUInt32BE(0) === 0x7f454c46, 'no es ELF');
  const cls = buf[4];
  assert.strictEqual(buf[5], 1, 'no es little-endian');
  const is64 = cls === 2;
  const type = buf.readUInt16LE(16);
  const machine = buf.readUInt16LE(18);
  const flags = buf.readUInt32LE(is64 ? 48 : 36);
  const phoff = is64 ? Number(buf.readBigUInt64LE(32)) : buf.readUInt32LE(28);
  const phentsize = buf.readUInt16LE(is64 ? 54 : 42);
  const phnum = buf.readUInt16LE(is64 ? 56 : 44);
  const ptypes = [];
  for (let i = 0; i < phnum; i++) ptypes.push(buf.readUInt32LE(phoff + i * phentsize));
  return { cls, type, machine, flags, ptypes };
}

async function seccionKeeperFiles({ check, ROOT }) {
  const KDIR = path.join(ROOT, 'electron', 'keeper');
  const manifest = JSON.parse(fs.readFileSync(path.join(KDIR, 'manifest.json'), 'utf8'));

  await check('KB1 manifest.json del keeper: cada binario existe con su size y sha256, y nada sobra en bin/', () => {
    const kv = Number(/^#define KEEPER_VERSION (\d+)/m.exec(fs.readFileSync(path.join(KDIR, 'src', 'keeper.h'), 'utf8'))[1]);
    assert.strictEqual(manifest.kv, kv, `manifest kv=${manifest.kv} pero keeper.h dice ${kv}: npm run keeper:build`);
    assert.deepStrictEqual(Object.keys(manifest.binaries).sort(), Object.keys(ARCHS).sort(), 'arquitecturas del manifest');
    for (const [arch, b] of Object.entries(manifest.binaries)) {
      assert.strictEqual(b.file, `termilab-keeper-${kv}-${arch}`, `nombre de ${arch}`);
      const buf = fs.readFileSync(path.join(KDIR, 'bin', b.file));
      assert.strictEqual(buf.length, b.size, `${b.file}: size`);
      assert.strictEqual(crypto.createHash('sha256').update(buf).digest('hex'), b.sha256, `${b.file}: sha256`);
    }
    const listados = new Set(Object.values(manifest.binaries).map(b => b.file));
    const sobran = fs.readdirSync(path.join(KDIR, 'bin')).filter(f => !listados.has(f));
    assert.deepStrictEqual(sobran, [], 'archivos en keeper/bin/ que el manifest no lista (viajarian en el paquete)');
  });

  await check('KB2 binarios del keeper: ELF estatico de la arquitectura declarada', () => {
    for (const [arch, b] of Object.entries(manifest.binaries)) {
      const elf = leeElf(fs.readFileSync(path.join(KDIR, 'bin', b.file)));
      const want = ARCHS[arch];
      assert.strictEqual(elf.cls, want.cls, `${b.file}: EI_CLASS`);
      assert.strictEqual(elf.machine, want.machine, `${b.file}: e_machine ${elf.machine}`);
      assert.ok(elf.type === 2 || elf.type === 3, `${b.file}: e_type ${elf.type}`);
      assert.ok(!elf.ptypes.includes(PT_INTERP), `${b.file}: tiene PT_INTERP (no es estatico)`);
      assert.ok(!elf.ptypes.includes(PT_DYNAMIC), `${b.file}: tiene PT_DYNAMIC`);
      if (arch === 'armv7l') {
        assert.strictEqual(elf.flags & 0xff000000, 0x05000000, `${b.file}: no es EABI5`);
        assert.ok(elf.flags & 0x400, `${b.file}: no es hard-float`);
      }
    }
  });

  await check('KB3 build-keeper.sh fija la version de Zig (y el README dice la misma)', () => {
    const sh = fs.readFileSync(path.join(ROOT, 'scripts', 'build-keeper.sh'), 'utf8');
    const m = /^ZIG_VERSION="([0-9.]+)"$/m.exec(sh);
    assert.ok(m, 'build-keeper.sh no tiene ZIG_VERSION="x.y.z"');
    assert.ok(/\[ "\$got" = "\$ZIG_VERSION" \]/.test(sh), 'build-keeper.sh no compara la version de zig');
    const readme = fs.readFileSync(path.join(KDIR, 'README.md'), 'utf8');
    assert.ok(readme.includes(`Zig ${m[1]}`), `README no dice Zig ${m[1]}`);
    const zig = process.env.ZIG || path.join(require('os').homedir(), 'opt', 'zig', 'zig');
    if (fs.existsSync(zig)) {
      const v = execFileSync(zig, ['version'], { encoding: 'utf8' }).trim();
      assert.strictEqual(v, m[1], `zig en ${zig} es ${v}, el pin es ${m[1]}`);
    }
  });

  await check('KB4 empaquetado: src/ y test/ del keeper fuera, npm run keeper:build existe', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.ok(pkg.build.files.includes('electron/**/*'), 'files ya no incluye electron/**/* (los binarios no viajarian)');
    assert.ok(pkg.build.files.includes('!electron/keeper/{src,test}/**'), 'files no excluye keeper/src y keeper/test');
    assert.ok(!JSON.stringify(pkg.build.asarUnpack || []).includes('keeper'),
      'keeper en asarUnpack: no hace falta, se leen con readFileSync desde el asar');
    assert.strictEqual(pkg.scripts['keeper:build'], 'bash scripts/build-keeper.sh');
  });
}

module.exports = { seccionKeeperFiles, leeElf };

if (require.main === module) {
  let fallos = 0;
  const check = (name, fn) => Promise.resolve().then(fn)
    .then(() => console.log(`  ok   ${name}`))
    .catch(e => { fallos++; console.log(`  FAIL ${name}\n       ${e.message}`); });
  seccionKeeperFiles({ check, ROOT: path.join(__dirname, '..', '..') })
    .then(() => process.exit(fallos ? 1 : 0));
}
