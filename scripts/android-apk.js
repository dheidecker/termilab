#!/usr/bin/env node
/**
 * Release APK: signed, arm64-v8a, into release/ with its update feed.
 * Run through `npm run android:apk`, which syncs web + node first.
 *
 *   release/Termilab-<v>-android-arm64.apk
 *   release/latest-android.json        {version, versionCode, file, sha256, size}
 *
 * Then checks what a phone will check: the APK signature (apksigner), 16 KB
 * zip alignment of the uncompressed native libs (zipalign -c -P 16) and the
 * ELF LOAD alignment (>= 0x4000) of every .so inside the APK.
 *
 * Signing needs the release keystore (see mobile/android/app/build.gradle and
 * CLAUDE.md, Releasing). Without it Gradle emits an unsigned APK and this fails.
 *
 * For the updater's end-to-end test only (never publish these):
 *   TERMILAB_VERSION=1.11.0        another version (package.json is not touched;
 *                                  set it for `npm run android:apk` as a whole so
 *                                  the Node bundle carries the same number)
 *   TERMILAB_ABI=x86_64            the emulator's ABI
 *   TERMILAB_BUILD_TYPE=updateTest release + debuggable (honours TERMILAB_UPDATE_URL)
 *   TERMILAB_OUT=<dir>             somewhere other than release/
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { writeManifest } = require('../mobile/scripts/write-manifest');

const ROOT = path.join(__dirname, '..');
const ANDROID = path.join(ROOT, 'mobile', 'android');
const version = process.env.TERMILAB_VERSION || require(path.join(ROOT, 'package.json')).version;
const abi = process.env.TERMILAB_ABI || 'arm64-v8a';
const buildType = process.env.TERMILAB_BUILD_TYPE || 'release';
const outDir = path.resolve(process.env.TERMILAB_OUT || path.join(ROOT, 'release'));
const abiLabel = abi === 'arm64-v8a' ? 'arm64' : abi;

const env = { ...process.env };
if (!env.JAVA_HOME && fs.existsSync(path.join(os.homedir(), 'Android', 'jdk'))) env.JAVA_HOME = path.join(os.homedir(), 'Android', 'jdk');
if (!env.ANDROID_HOME && fs.existsSync(path.join(os.homedir(), 'Android', 'Sdk'))) env.ANDROID_HOME = path.join(os.homedir(), 'Android', 'Sdk');
if (env.JAVA_HOME) env.PATH = `${path.join(env.JAVA_HOME, 'bin')}${path.delimiter}${env.PATH}`;
if (!env.ANDROID_HOME) throw new Error('ANDROID_HOME is not set');

function buildTool(name) {
  const dir = path.join(env.ANDROID_HOME, 'build-tools');
  const versions = fs.readdirSync(dir).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const v of versions) {
    const p = path.join(dir, v, name);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`${name} not found under ${dir}`);
}

/** p_align of every PT_LOAD segment of a 64-bit little-endian ELF. */
function loadAlignments(buf) {
  if (buf.readUInt32BE(0) !== 0x7f454c46 || buf[4] !== 2 || buf[5] !== 1) throw new Error('not a 64-bit little-endian ELF');
  const phoff = Number(buf.readBigUInt64LE(0x20));
  const phentsize = buf.readUInt16LE(0x36);
  const phnum = buf.readUInt16LE(0x38);
  const out = [];
  for (let i = 0; i < phnum; i++) {
    const at = phoff + i * phentsize;
    if (buf.readUInt32LE(at) === 1) out.push(Number(buf.readBigUInt64LE(at + 0x30)));
  }
  return out;
}

const task = `assemble${buildType[0].toUpperCase()}${buildType.slice(1)}`;
const gradlew = path.join(ANDROID, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
execFileSync(gradlew, [task, `-PtermilabAbis=${abi}`, `-PtermilabVersion=${version}`], { cwd: ANDROID, env, stdio: 'inherit' });

const built = path.join(ANDROID, 'app', 'build', 'outputs', 'apk', buildType, `app-${abi}-${buildType}.apk`);
if (!fs.existsSync(built)) {
  const unsigned = built.replace(/\.apk$/, '-unsigned.apk');
  if (fs.existsSync(unsigned)) throw new Error(`Gradle built an UNSIGNED APK (${path.relative(ROOT, unsigned)}): no release keystore found. See CLAUDE.md, Releasing.`);
  throw new Error(`APK not found: ${built}`);
}

fs.mkdirSync(outDir, { recursive: true });
const suffix = buildType === 'release' ? '' : `-${buildType}`;
const apk = path.join(outDir, `Termilab-${version}-android-${abiLabel}${suffix}.apk`);
fs.copyFileSync(built, apk);

// ─── Checks ────────────────────────────────────────────────
const apksigner = buildTool('apksigner');
const certs = execFileSync(apksigner, ['verify', '--print-certs', apk], { env, encoding: 'utf-8' });
const digest = (/certificate SHA-256 digest: ([0-9a-f]+)/.exec(certs) || [])[1];
if (!digest) throw new Error('apksigner printed no certificate digest');
if (/CN=Android Debug/.test(certs)) throw new Error('APK is signed with the DEBUG key');

execFileSync(buildTool('zipalign'), ['-c', '-P', '16', '-v', '4', apk], { env, stdio: ['ignore', 'ignore', 'inherit'] });

const libs = execFileSync('unzip', ['-Z1', apk], { encoding: 'utf-8' }).split('\n').filter(n => /^lib\/.+\.so$/.test(n));
const misaligned = [];
for (const lib of libs) {
  const buf = execFileSync('unzip', ['-p', apk, lib], { maxBuffer: 512 * 1024 * 1024 });
  const aligns = loadAlignments(buf);
  if (!aligns.length || aligns.some(a => a < 0x4000)) misaligned.push(`${lib} (${aligns.map(a => '0x' + a.toString(16)).join(',')})`);
}
if (misaligned.length) throw new Error(`native libs not 16 KB aligned: ${misaligned.join('; ')}`);

const { out, manifest } = writeManifest(apk, version, outDir);
console.log(`\nAPK:       ${path.relative(ROOT, apk)} (${(manifest.size / 1e6).toFixed(1)} MB, ${buildType}, ${abi})`);
console.log(`manifest:  ${path.relative(ROOT, out)} v${manifest.version} versionCode ${manifest.versionCode}`);
console.log(`sha256:    ${manifest.sha256}`);
console.log(`signer:    certificate SHA-256 ${digest}`);
console.log(`16 KB:     zipalign -c -P 16 OK; ${libs.length} native libs, every LOAD segment >= 0x4000`);
