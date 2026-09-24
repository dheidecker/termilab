#!/usr/bin/env node
/**
 * Bundles the Android Node side (mobile/node/main.js + the real electron/
 * graph) into one CommonJS file for nodejs-mobile.
 *
 *   node scripts/build-mobile-node.js                 # -> dist-mobile/nodejs/index.js
 *   node scripts/build-mobile-node.js <outfile>       # used by scripts/check-mobile.js
 *
 * - `electron` is aliased to mobile/node/electron-shim.js.
 * - target node18: nodejs-mobile ships Node 18.20.4.
 * - external: `bridge` (the plugin injects it through NODE_PATH), native
 *   addons (`*.node`, cpu-features, node-pty): ssh2 falls back to pure JS
 *   without them (spike: bindingAvailable=false), local-shell-service catches
 *   the missing node-pty.
 *
 * Run AFTER `vite build -c vite.mobile.config.js`: that one empties dist-mobile/.
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const DEFAULT_OUT = path.join(ROOT, 'dist-mobile', 'nodejs', 'index.js');

async function build(outfile = DEFAULT_OUT) {
  const esbuild = require('esbuild');
  // TERMILAB_VERSION: build another version for the updater's tests (scripts/android-apk.js).
  const version = process.env.TERMILAB_VERSION || require(path.join(ROOT, 'package.json')).version;
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'mobile', 'node', 'main.js')],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    alias: { electron: path.join(ROOT, 'mobile', 'node', 'electron-shim.js') },
    external: ['bridge', 'cpu-features', 'node-pty', 'electron-updater', '*.node'],
    define: { __TERMILAB_VERSION__: JSON.stringify(version) },
    legalComments: 'none',
    logLevel: 'warning',
  });
  // The plugin reads "main" from here; without it, index.js is assumed anyway.
  fs.writeFileSync(path.join(path.dirname(outfile), 'package.json'),
    JSON.stringify({ name: 'termilab-node', private: true, main: path.basename(outfile) }, null, 2) + '\n');
  return outfile;
}

module.exports = { build, DEFAULT_OUT };

if (require.main === module) {
  build(process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_OUT)
    .then(out => console.log(`mobile node bundle: ${path.relative(ROOT, out)} (${(fs.statSync(out).size / 1024).toFixed(0)} kB)`))
    .catch(err => { console.error(err.message); process.exit(1); });
}
