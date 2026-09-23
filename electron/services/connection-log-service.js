/**
 * Connection history for the Logs section. Recorded here in main, not in the
 * renderer, so the end time is real even when a tab is closed or the app quits.
 *
 * Entry: { id, type: 'ssh'|'sftp'|'local', hostId?, label, hostname?, port?,
 *          username?, os?, email, deviceName, startedAt, endedAt? }
 *
 * Never records commands, output, passwords or keys. Synced as the plaintext
 * `connection_logs` collection (same data class as hosts). Ids are random per
 * entry, so two devices never write the same row; the cap is applied by
 * startedAt and what it drops leaves as a tombstone (see store-service).
 */

const os = require('os');
const crypto = require('crypto');
const storeService = require('./store-service');

const MAX_ENTRIES = 1000;

class ConnectionLogService {
  constructor() {
    /** ids of entries this process opened and has not closed yet */
    this._open = new Set();
    /** id -> pending start() promise, so end()/setOs() never beat the insert */
    this._writes = new Map();
    this._closedForQuit = false;
  }

  /* Account + device as the sync service knows them. Best effort: signed out,
     or sync unreadable, gives a blank email and the machine's hostname. */
  async _identity() {
    let email = '';
    let deviceName = '';
    try {
      const syncService = require('./sync-service');
      if (typeof syncService._load === 'function') await syncService._load();
      email = syncService.state?.email || '';
      deviceName = syncService.state?.deviceName || '';
    } catch (_) { /* no sync: fall through */ }
    return { email, deviceName: deviceName || os.hostname() };
  }

  /**
   * Open an entry. Returns its id synchronously; the write happens behind.
   * `info`: { type, hostId?, label?, hostname?, port?, username? }
   */
  start(info) {
    const id = crypto.randomUUID();
    if (this._closedForQuit) return id;
    this._open.add(id);
    /* Stamped now, not after the identity lookup below: end() stamps
       synchronously too, and a late start could otherwise land after it. */
    const startedAt = new Date().toISOString();
    const write = (async () => {
      const identity = await this._identity();
      let hostId = null;
      if (info.hostId) {
        try {
          const hosts = await storeService.getHosts();
          if (hosts.some(h => h.id === info.hostId)) hostId = info.hostId;
        } catch (_) { /* unknown: leave it unsaved */ }
      }
      const entry = {
        id,
        type: info.type === 'local' || info.type === 'sftp' ? info.type : 'ssh',
        hostId,
        label: info.type === 'local'
          ? 'Local Terminal'
          : String(info.label || info.hostname || '').slice(0, 200),
        startedAt,
        ...identity,
      };
      if (entry.type !== 'local') {
        entry.hostname = String(info.hostname || '');
        entry.port = Number(info.port) || 22;
        entry.username = String(info.username || '');
      }
      await storeService.addConnectionLog(entry, MAX_ENTRIES);
    })().catch(err => {
      console.error('[ConnectionLog] Could not record start:', err.message);
    });
    this._writes.set(id, write);
    write.finally(() => { if (this._writes.get(id) === write) this._writes.delete(id); });
    return id;
  }

  async _after(id) {
    const w = this._writes.get(id);
    if (w) await w;
  }

  /** Close an entry. Idempotent. */
  end(id) {
    if (!id || !this._open.has(id)) return Promise.resolve();
    this._open.delete(id);
    const endedAt = new Date().toISOString();
    return this._after(id)
      .then(() => storeService.updateConnectionLog(id, { endedAt }))
      .catch(err => console.error('[ConnectionLog] Could not record end:', err.message));
  }

  /** The distro, once os-detect finds it. */
  setOs(id, osId) {
    if (!id || typeof osId !== 'string' || !osId) return Promise.resolve();
    return this._after(id)
      .then(() => storeService.updateConnectionLog(id, { os: osId }))
      .catch(() => { /* cosmetic */ });
  }

  async list() {
    return storeService.getConnectionLogs();
  }

  async clear() {
    await Promise.all([...this._writes.values()]);
    return storeService.clearConnectionLogs();
  }

  /**
   * before-quit (main.js holds the quit until this settles): close every open
   * entry. Waits for inserts still in flight, then stamps under the store
   * lock so no async write overlaps it. Never takes longer than `timeoutMs`
   * in total: past that, the synchronous stamp runs anyway.
   */
  async closeAllForQuit(timeoutMs = 2000) {
    this._closedForQuit = true;
    const ids = [...this._open];
    this._open.clear();
    if (!ids.length) return 0;
    const endedAt = new Date().toISOString();
    const deadline = Date.now() + timeoutMs;
    const inserts = ids.map(id => this._writes.get(id)).filter(Boolean);
    if (inserts.length) {
      let timer;
      await Promise.race([
        Promise.all(inserts),
        new Promise(r => { timer = setTimeout(r, timeoutMs); }),
      ]);
      clearTimeout(timer);
    }
    try {
      return await storeService.closeConnectionLogs(ids, endedAt, { lockMs: Math.max(0, deadline - Date.now()) });
    } catch (err) {
      console.error('[ConnectionLog] Could not close entries on quit:', err.message);
      return 0;
    }
  }

  /**
   * Synchronous last resort (no lock, no waiting): entries whose insert is
   * still in flight cannot be reached this way. Prefer closeAllForQuit.
   */
  closeAllSync() {
    this._closedForQuit = true;
    const ids = [...this._open];
    this._open.clear();
    try {
      return storeService.closeConnectionLogsSync(ids, new Date().toISOString());
    } catch (err) {
      console.error('[ConnectionLog] Could not close entries on quit:', err.message);
      return 0;
    }
  }
}

module.exports = new ConnectionLogService();
module.exports.MAX_ENTRIES = MAX_ENTRIES;
