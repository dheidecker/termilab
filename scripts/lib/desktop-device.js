#!/usr/bin/env node
/**
 * One simulated DESKTOP device for scripts/check-mobile.js: the electron/
 * services loaded straight from the source tree with `electron` stubbed the
 * way scripts/check-main.js does (fake keychain). Runs in its own process so
 * that nothing it loads shares module state with the mobile side.
 *
 *   TERMILAB_SYNC_URL=http://127.0.0.1:PORT node desktop-device.js '<json>'
 *
 * json: {action: 'create'|'open', userData, token, passphrase, hosts?, keys?}
 * Prints one line: JSON {ok, ...} (or {ok:false, error}).
 */
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..');
const req = JSON.parse(process.argv[2] || '{}');

const electronStub = {
  app: { getPath: () => req.userData, getVersion: () => '0.0.0-desktop', getName: () => 'Termilab', on: () => {} },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`fake:${value}`, 'utf-8'),
    decryptString: buf => buf.toString('utf-8').replace(/^fake:/, ''),
  },
  shell: { openExternal: () => Promise.resolve() },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return realLoad.call(this, request, parent, isMain);
};

// Everything else on stdout would corrupt the one JSON line the parent reads.
console.log = console.info = console.warn = (...a) => process.stderr.write(`${a.join(' ')}\n`);

async function main() {
  const svc = name => require(path.join(ROOT, 'electron', 'services', name));
  const cryptoService = svc('crypto-service.js');
  const storeService = svc('store-service.js');
  const syncService = svc('sync-service.js');

  await cryptoService.setToken(req.token);
  if (req.action === 'create') {
    for (const host of req.hosts || []) await storeService.saveHost(host);
    for (const key of req.keys || []) await storeService.saveKey(key);
    const setup = await syncService.setupPassphrase(req.passphrase);
    await syncService.syncNow();
    return { setup, status: await syncService.status() };
  }
  if (req.action === 'open') {
    await syncService.syncNow();
    const unlock = await syncService.unlock(req.passphrase);
    await syncService.syncNow();
    return {
      unlock,
      status: await syncService.status(),
      hosts: await storeService.readRaw('hosts'),
      keys: await storeService.readRaw('keys'),
    };
  }
  throw new Error(`unknown action ${req.action}`);
}

main()
  .then(out => { process.stdout.write(`${JSON.stringify({ ok: true, ...out })}\n`); process.exit(0); })
  .catch(err => { process.stdout.write(`${JSON.stringify({ ok: false, error: err && err.stack })}\n`); process.exit(1); });
