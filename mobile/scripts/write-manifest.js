#!/usr/bin/env node
/**
 * Writes the Android update feed next to a release APK:
 *
 *   node mobile/scripts/write-manifest.js <apk> <version> [outdir]
 *     -> <outdir or the APK's dir>/latest-android.json
 *        {version, versionCode, file, sha256, size}
 *
 * The app (mobile/node/updater.js) fetches it from
 * github.com/dheidecker/termilab/releases/latest/download/latest-android.json,
 * resolves `file` against that URL and refuses an APK whose size or sha256
 * differ. Upload both files to the SAME release as the desktop assets.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { versionCodeOf, parseManifest } = require('../node/updater');

function writeManifest(apk, version, outDir = path.dirname(apk)) {
  const buf = fs.readFileSync(apk);
  const manifest = {
    version,
    versionCode: versionCodeOf(version),
    file: path.basename(apk),
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    size: buf.length,
  };
  parseManifest(JSON.stringify(manifest));   // the app's own validation, or throw here
  const out = path.join(outDir, 'latest-android.json');
  fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
  return { out, manifest };
}

module.exports = { writeManifest };

if (require.main === module) {
  const [apk, version, outDir] = process.argv.slice(2);
  if (!apk || !version) { console.error('usage: write-manifest.js <apk> <version> [outdir]'); process.exit(2); }
  const { out, manifest } = writeManifest(path.resolve(apk), version, outDir ? path.resolve(outDir) : undefined);
  console.log(`${out}: ${manifest.file} v${manifest.version} (${manifest.versionCode}) ${manifest.size} bytes sha256 ${manifest.sha256}`);
}
