/**
 * Android updater, in Node. Speaks the same `updater:*` IPC and the same
 * `updater:status` events as electron-updater does in electron/main.js, so
 * Settings -> About and UpdateNotification work unchanged:
 *
 *   checking | available {version} | up-to-date
 *   downloading {percent, transferred, total} | ready {version} | error {message}
 *
 * The feed is one JSON file next to the APK in the GitHub release
 * (written by mobile/scripts/write-manifest.js):
 *
 *   latest-android.json  {version, versionCode, file, sha256, size}
 *
 * `file` is resolved against the manifest's URL. A 404 on the manifest means
 * "no Android build in the latest release": up to date, not an error.
 *
 * What protects the install: the manifest is fetched over https (the override
 * for tests exists only in debuggable builds, see MainActivity); the APK must
 * match the manifest's size and sha256 byte for byte, checked again right
 * before installing; and Java (TermilabNativePlugin.installApk) refuses an
 * archive for another package, an older versionCode or another signing key
 * before Android's own installer, which enforces the signature too.
 *
 * No Electron here: this module is pure Node so scripts/check-mobile.js can
 * load it directly.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_MANIFEST_URL = 'https://github.com/dheidecker/termilab/releases/latest/download/latest-android.json';
const MAX_APK_BYTES = 512 * 1024 * 1024;
const MANIFEST_TIMEOUT_MS = 30000;
const DOWNLOAD_IDLE_MS = 60000;
const APK_NAME = /^[A-Za-z0-9._-]+\.apk$/;

/** An error whose message is already what the user should read. */
const own = (message) => Object.assign(new Error(message), { own: true });

/** '1.11.1' -> 1011001. Throws on anything that is not major.minor.patch. */
function versionCodeOf(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version || '').trim());
  if (!m) throw new Error(`Not a major.minor.patch version: ${version}`);
  const [major, minor, patch] = m.slice(1).map(Number);
  if (minor > 999 || patch > 999) throw new Error(`Version does not fit a versionCode: ${version}`);
  return major * 1000000 + minor * 1000 + patch;
}

/** Parses and validates latest-android.json. Throws with a readable reason. */
function parseManifest(text) {
  let m;
  try { m = JSON.parse(text); } catch (_) { throw new Error('Update manifest is not valid JSON'); }
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('Update manifest is not an object');
  const { version, versionCode, file, sha256, size } = m;
  if (typeof version !== 'string') throw new Error('Update manifest has no version');
  if (!Number.isSafeInteger(versionCode) || versionCode <= 0) throw new Error('Update manifest has no valid versionCode');
  if (versionCodeOf(version) !== versionCode) throw new Error(`Update manifest versionCode ${versionCode} does not match version ${version}`);
  if (typeof file !== 'string' || !APK_NAME.test(file)) throw new Error('Update manifest has no valid APK file name');
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error('Update manifest has no valid sha256');
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_APK_BYTES) throw new Error('Update manifest has no valid size');
  return { version, versionCode, file, sha256, size };
}

/** True when the manifest offers something newer than what is installed. */
function isNewer(manifest, installedVersionCode) {
  return manifest.versionCode > installedVersionCode;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}

/** Does `file` exist with exactly this size and sha256? */
async function verifyFile(file, { size, sha256 }) {
  let st;
  try { st = fs.statSync(file); } catch (_) { return false; }
  if (st.size !== size) return false;
  return (await sha256File(file)) === sha256;
}

/**
 * @param {object} o
 * @param {string} o.dataPath             Node's DATADIR; APKs go to <dataPath>/updates/
 * @param {number} o.installedVersionCode from native (PackageInfo), at boot
 * @param {string} [o.manifestUrl]
 * @param {(status: string, data?: object) => void} o.emit        updater:status
 * @param {(apk: {path, version, versionCode}) => Promise<any>} o.installApk  native installer
 * @param {typeof fetch} [o.fetch]
 */
function createUpdater({ dataPath, installedVersionCode, manifestUrl = DEFAULT_MANIFEST_URL, emit, installApk, fetch: fetchImpl = globalThis.fetch }) {
  const dir = path.join(dataPath, 'updates');
  const manifestHref = new URL(manifestUrl).href;
  let offered = null;       // the manifest last seen as newer
  let ready = null;         // {manifest, file} verified on disk
  let checking = null;      // in-flight check promise
  let downloading = null;   // in-flight download promise

  const apkPath = m => path.join(dir, `Termilab-${m.versionCode}.apk`);
  const fail = (err) => { emit('error', { message: err.message }); return err; };

  /** Old downloads: anything not newer than what runs now, and partial files. */
  function cleanup() {
    let names;
    try { names = fs.readdirSync(dir); } catch (_) { return []; }
    const removed = [];
    for (const name of names) {
      const m = /^Termilab-(\d+)\.apk$/.exec(name);
      if (name.endsWith('.part') || !m || Number(m[1]) <= installedVersionCode) {
        try { fs.rmSync(path.join(dir, name), { force: true, recursive: true }); removed.push(name); } catch (_) { /* next boot */ }
      }
    }
    return removed;
  }

  async function doCheck() {
    emit('checking');
    let res;
    try {
      res = await fetchImpl(manifestHref, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS) });
    } catch (err) {
      throw fail(new Error(`Could not reach the update server: ${err.cause ? err.cause.message || err.cause.code : err.message}`));
    }
    if (res.status === 404) {
      offered = null;
      emit('up-to-date');
      return { isUpdateAvailable: false };
    }
    if (!res.ok) throw fail(new Error(`Update server answered HTTP ${res.status}`));
    let manifest;
    try { manifest = parseManifest(await res.text()); } catch (err) { throw fail(err); }
    if (!isNewer(manifest, installedVersionCode)) {
      offered = null;
      emit('up-to-date');
      return { isUpdateAvailable: false, updateInfo: { version: manifest.version } };
    }
    offered = manifest;
    if (ready && ready.manifest.sha256 !== manifest.sha256) ready = null;
    emit('available', { version: manifest.version });
    return { isUpdateAvailable: true, updateInfo: { version: manifest.version, versionCode: manifest.versionCode, size: manifest.size } };
  }

  function check() {
    if (!checking) checking = doCheck().finally(() => { checking = null; });
    return checking;
  }

  async function doDownload() {
    const manifest = offered;
    if (!manifest) throw fail(new Error('No update to download. Check for updates first.'));
    const target = apkPath(manifest);
    fs.mkdirSync(dir, { recursive: true });
    if (await verifyFile(target, manifest)) {
      ready = { manifest, file: target };
      emit('ready', { version: manifest.version });
      return { version: manifest.version };
    }
    const part = `${target}.part`;
    fs.rmSync(part, { force: true });
    const url = new URL(manifest.file, manifestHref).href;
    const ctrl = new AbortController();
    let idle = setTimeout(() => ctrl.abort(new Error('download stalled')), DOWNLOAD_IDLE_MS);
    const touch = () => { clearTimeout(idle); idle = setTimeout(() => ctrl.abort(new Error('download stalled')), DOWNLOAD_IDLE_MS); };
    const hash = crypto.createHash('sha256');
    let transferred = 0;
    let lastPercent = -1;
    let out = null;
    try {
      const res = await fetchImpl(url, { signal: ctrl.signal });
      if (!res.ok || !res.body) throw own(`Update download answered HTTP ${res.status}`);
      out = fs.openSync(part, 'w');
      emit('downloading', { percent: 0, transferred: 0, total: manifest.size });
      for await (const chunk of res.body) {
        touch();
        const buf = Buffer.from(chunk);
        transferred += buf.length;
        if (transferred > manifest.size) throw own('Downloaded update is larger than the manifest says; refused');
        hash.update(buf);
        fs.writeSync(out, buf);
        const percent = Math.floor((transferred / manifest.size) * 100);
        if (percent !== lastPercent) {
          lastPercent = percent;
          emit('downloading', { percent, transferred, total: manifest.size });
        }
      }
      fs.closeSync(out); out = null;
      if (transferred !== manifest.size) throw own(`Downloaded update is ${transferred} bytes, the manifest says ${manifest.size}; refused`);
      const digest = hash.digest('hex');
      if (digest !== manifest.sha256) throw own('Downloaded update failed verification (sha256 mismatch); refused');
      fs.renameSync(part, target);
    } catch (err) {
      if (out !== null) { try { fs.closeSync(out); } catch (_) { /* already closed */ } }
      fs.rmSync(part, { force: true });
      if (err.name === 'AbortError' || err.name === 'TimeoutError') throw fail(new Error('Update download stalled; try again'));
      throw fail(err.own ? err : new Error(`Update download failed: ${err.cause ? err.cause.message || err.cause.code : err.message}`));
    } finally {
      clearTimeout(idle);
    }
    ready = { manifest, file: target };
    emit('ready', { version: manifest.version });
    return { version: manifest.version };
  }

  function download() {
    if (!downloading) downloading = doDownload().finally(() => { downloading = null; });
    return downloading;
  }

  async function install() {
    if (!ready) throw fail(new Error('No downloaded update to install'));
    const { manifest, file } = ready;
    // Once more: the file sat on disk since the download.
    if (!(await verifyFile(file, manifest))) {
      ready = null;
      fs.rmSync(file, { force: true });
      throw fail(new Error('Downloaded update failed verification (sha256 mismatch); refused. Download it again.'));
    }
    try {
      return await installApk({ path: file, version: manifest.version, versionCode: manifest.versionCode });
    } catch (err) {
      throw fail(new Error(err && err.message ? err.message : String(err)));
    }
  }

  return { check, download, install, cleanup, dir, get offered() { return offered; }, get ready() { return ready; } };
}

module.exports = { createUpdater, parseManifest, versionCodeOf, isNewer, verifyFile, sha256File, DEFAULT_MANIFEST_URL };
