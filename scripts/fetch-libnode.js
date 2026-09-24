#!/usr/bin/env node
/**
 * Puts the prebuilt nodejs-mobile runtime (libnode.so + headers) into the vendored
 * Capacitor-NodeJS plugin: mobile/vendor/capacitor-nodejs/android/libnode/.
 *
 * Those files are ~135 MB (two ABIs + 634 headers), so they are NOT in git. They come
 * from the plugin's own release tarball, pinned by sha256, and each libnode.so is
 * checked again after extraction. The bundled runtime is `18.20.4+16kb-fix`: its LOAD
 * segments are aligned to 16 KB (0x4000). The plain nodejs-mobile v18.20.4 release is
 * NOT (0x1000) and fails to dlopen on 16 KB-page devices — never swap it in.
 *
 *   node scripts/fetch-libnode.js            # download (cached) + extract + verify
 *   TERMILAB_CNJS_TGZ=/path/capacitor-nodejs.tgz node scripts/fetch-libnode.js   # offline
 *
 * Idempotent: if both .so files are already there with the right hash, it does nothing.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'mobile', 'vendor', 'capacitor-nodejs');
const LIBNODE = path.join(VENDOR, 'android', 'libnode');
const CACHE = path.join(ROOT, 'mobile', 'vendor', '.cache');
const URL = 'https://github.com/hampoelz/capacitor-nodejs/releases/download/v1.0.0-beta.10/capacitor-nodejs.tgz';
const TGZ_SHA256 = 'cc47cba4190d5e0ea8e2b33f4e9bd47e159570c01571c51214467e4c21e87bd3';
// Only the ABIs we ship: arm64-v8a (phones) and x86_64 (emulator). armeabi-v7a is dropped.
const SO_SHA256 = {
  'arm64-v8a': '4515d3b51efebfb177714a79d35200a3b9880aea9d145e01688518e5b47ac313',
  x86_64: '2abee2b73f5df33f2d66221c1c0c111d81fd8d0a100a9062a84428dd92e14a9c',
};

const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const soPath = abi => path.join(LIBNODE, 'bin', abi, 'libnode.so');

function alreadyThere() {
  if (!fs.existsSync(path.join(LIBNODE, 'include', 'node', 'node.h'))) return false;
  return Object.entries(SO_SHA256).every(([abi, sum]) => fs.existsSync(soPath(abi)) && sha256(soPath(abi)) === sum);
}

async function getTarball() {
  if (process.env.TERMILAB_CNJS_TGZ) return process.env.TERMILAB_CNJS_TGZ;
  const cached = path.join(CACHE, 'capacitor-nodejs-1.0.0-beta.10.tgz');
  if (fs.existsSync(cached) && sha256(cached) === TGZ_SHA256) return cached;
  fs.mkdirSync(CACHE, { recursive: true });
  console.log(`Downloading ${URL}`);
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  fs.writeFileSync(`${cached}.part`, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(`${cached}.part`, cached);
  return cached;
}

async function main() {
  if (alreadyThere()) {
    console.log('libnode already in place (hashes match).');
    return;
  }
  const tgz = await getTarball();
  const got = sha256(tgz);
  if (got !== TGZ_SHA256) throw new Error(`tarball sha256 mismatch: ${got} (expected ${TGZ_SHA256})`);

  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'termilab-libnode-'));
  try {
    execFileSync('tar', ['xzf', tgz, '-C', tmp, 'package/android/libnode'], { stdio: 'inherit' });
    const src = path.join(tmp, 'package', 'android', 'libnode');
    fs.rmSync(LIBNODE, { recursive: true, force: true });
    fs.mkdirSync(path.join(LIBNODE, 'bin'), { recursive: true });
    fs.cpSync(path.join(src, 'include'), path.join(LIBNODE, 'include'), { recursive: true });
    for (const abi of Object.keys(SO_SHA256)) {
      fs.mkdirSync(path.dirname(soPath(abi)), { recursive: true });
      fs.copyFileSync(path.join(src, 'bin', abi, 'libnode.so'), soPath(abi));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  for (const [abi, sum] of Object.entries(SO_SHA256)) {
    const h = sha256(soPath(abi));
    if (h !== sum) throw new Error(`${abi}/libnode.so sha256 mismatch: ${h}`);
  }
  console.log(`libnode ready in ${path.relative(ROOT, LIBNODE)} (${Object.keys(SO_SHA256).join(', ')})`);
}

main().catch(err => { console.error(`fetch-libnode: ${err.message}`); process.exit(1); });
