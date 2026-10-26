/*
 * `npm run dev` next to the installed Termilab.
 *
 * Both would otherwise share one userData (~/.config/termilab on Linux): the
 * same agent.sock, workspace.json, kept sessions, remote access on :7444 and
 * sync cursor. So an unpackaged dev run (VITE_DEV_SERVER_URL set, app not
 * packaged) moves to `<userData>-dev`, with its own single-instance lock (the
 * lock lives in userData). The first time, the host list is SEEDED from the
 * real data: hosts, groups, keys, snippets and known host keys are copied; the
 * real folder is only read, never written. Settings, sync secrets/state,
 * workspace and port forwards are NOT copied: the dev run starts with remote
 * access off and no sync account, so it cannot push anything to the server.
 *
 * TERMILAB_DEV_SHARED_DATA=1 keeps the old behaviour (shared userData, no
 * lock), and an explicit --user-data-dir is respected as is. A packaged build
 * never takes this path.
 */
const fs = require('fs');
const path = require('path');

const SEED_FILES = ['hosts.json', 'groups.json', 'keys.json', 'snippets.json', 'known-hosts.json'];
const SEED_MARK = '.seeded-from';

/**
 * Decide and apply. Must run before anything reads app.getPath('userData')
 * (store-service does at require time).
 * Returns { mode: 'off' | 'shared' | 'explicit' | 'separate', dir?, from?, copied? }.
 */
function setupDevUserData(app, { env = process.env, argv = process.argv } = {}) {
  if (!env.VITE_DEV_SERVER_URL || app.isPackaged !== false) return { mode: 'off' };
  if (env.TERMILAB_DEV_SHARED_DATA === '1') return { mode: 'shared' };
  if (argv.some(a => a === '--user-data-dir' || a.startsWith('--user-data-dir='))) return { mode: 'explicit' };
  if (typeof app.setPath !== 'function') return { mode: 'shared' };

  const from = app.getPath('userData');
  const dir = `${from}-dev`;
  const data = path.join(dir, 'data');
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  const copied = [];
  if (!fs.existsSync(path.join(data, SEED_MARK))) {
    for (const f of SEED_FILES) {
      const src = path.join(from, 'data', f);
      const dst = path.join(data, f);
      try {
        fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(dst, 0o600);
        copied.push(f);
      } catch (_) { /* missing in the real data, or already there */ }
    }
    try { fs.writeFileSync(path.join(data, SEED_MARK), `${from}\n`, { mode: 0o600 }); } catch (_) { /* seeds again next time */ }
  }
  app.setPath('userData', dir);
  /* Shells of this run: termilab-cli / termilab-mcp inside them talk to THIS instance */
  env.TERMILAB_USER_DATA = dir;
  return { mode: 'separate', dir, from, copied };
}

module.exports = { setupDevUserData, SEED_FILES };
