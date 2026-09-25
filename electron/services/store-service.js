const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

/**
 * The connection-log cap. Drops the OLDEST by `startedAt` (then id), not the
 * first on disk: synced entries arrive in any order, and every device must
 * drop the same ones so the tombstones sync sends for them agree. Disk order
 * is kept for the rest.
 */
function capConnectionLogs(list, cap) {
  if (!cap || list.length <= cap) return list;
  const key = e => `${String((e && e.startedAt) || '')}\u0000${String((e && e.id) || '')}`;
  const drop = new Set(
    list.slice().sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
      .slice(0, list.length - cap)
  );
  return list.filter(e => !drop.has(e));
}

/* host.color: null or '#rrggbb'. Only the format; the palette is renderer-side. */
const HOST_COLOR_RE = /^#[0-9a-f]{6}$/i;
/* Shown as-is by the swatch popover (the IPC envelope carries only the message) */
const SEALED_HOST_COLOR_ERROR = "Can't change this host's color here: its password is sealed by another device. "
  + 'Unlock sync on this device first (Settings → Sync).';

class StoreService {
  constructor() {
    this.dataDir = path.join(app.getPath('userData'), 'data');
    this._initialized = false;
    this._fileLocks = new Map();
    this._changeListeners = new Set();
  }

  /**
   * Called with the collection name after every local write — not after the
   * sync engine's own writes (`writeRaw`/`mutateRaw`), or a pull would
   * trigger another sync forever. Returns an unsubscribe function.
   */
  onLocalChange(fn) {
    this._changeListeners.add(fn);
    return () => this._changeListeners.delete(fn);
  }

  async _ensureDataDir() {
    if (this._initialized) return;
    try {
      await fsp.mkdir(this.dataDir, { recursive: true });
      this._initialized = true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      this._initialized = true;
    }
  }

  _getFilePath(collection) {
    return path.join(this.dataDir, `${collection}.json`);
  }

  async _acquireLock(collection) {
    while (this._fileLocks.get(collection)) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    this._fileLocks.set(collection, true);
  }

  /** Like _acquireLock, but gives up after `ms`. Resolves true if taken. */
  async _tryAcquireLock(collection, ms) {
    const deadline = Date.now() + ms;
    while (this._fileLocks.get(collection)) {
      if (Date.now() >= deadline) return false;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    this._fileLocks.set(collection, true);
    return true;
  }

  _releaseLock(collection) {
    this._fileLocks.delete(collection);
  }

  async _readCollection(collection) {
    await this._ensureDataDir();
    const filePath = this._getFilePath(collection);
    try {
      const data = await fsp.readFile(filePath, 'utf-8');
      return JSON.parse(data);
    } catch (err) {
      if (err.code === 'ENOENT') {
        return [];
      }
      console.error(`[StoreService] Error reading ${collection}:`, err.message);
      return [];
    }
  }

  async _writeCollection(collection, data, { fromSync = false } = {}) {
    await this._ensureDataDir();
    const filePath = this._getFilePath(collection);
    const tempPath = `${filePath}.tmp`;
    try {
      await fsp.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf-8');
      await fsp.rename(tempPath, filePath);
    } catch (err) {
      // Clean up temp file on failure
      try { await fsp.unlink(tempPath); } catch (_) { /* ignore */ }
      throw err;
    }
    if (!fromSync) {
      for (const fn of this._changeListeners) {
        try { fn(collection); } catch (_) { /* a listener never breaks a write */ }
      }
    }
  }

  async _readSettings() {
    await this._ensureDataDir();
    const filePath = this._getFilePath('settings');
    try {
      const data = await fsp.readFile(filePath, 'utf-8');
      return JSON.parse(data);
    } catch (err) {
      if (err.code === 'ENOENT') {
        return this._getDefaultSettings();
      }
      console.error('[StoreService] Error reading settings:', err.message);
      return this._getDefaultSettings();
    }
  }

  /**
   * Settings are written by more than one caller at once: every getSettings()
   * may rewrite the file (see _purgeAiCredentials) while saveSettings() runs.
   * Without the lock both wrote the same `settings.json.tmp` and raced on the
   * rename — the loser failed with ENOENT and its write was lost. Every other
   * writer in this class already serializes on _acquireLock; settings did not.
   */
  async _writeSettings(settings) {
    await this._ensureDataDir();
    await this._acquireLock('settings');
    const filePath = this._getFilePath('settings');
    /* Unique temp name so a stray writer can never rename ours away */
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fsp.writeFile(tempPath, JSON.stringify(settings, null, 2), 'utf-8');
      await fsp.rename(tempPath, filePath);
    } catch (err) {
      try { await fsp.unlink(tempPath); } catch (_) { /* ignore */ }
      throw err;
    } finally {
      this._releaseLock('settings');
    }
  }

  _getDefaultSettings() {
    return {
      terminal: {
        fontSize: 14,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
        cursorStyle: 'block',
        cursorBlink: true,
        scrollback: 10000,
        // Must be a TERMINAL_THEMES id — 'dark' silently fell back to this one
        theme: 'github-dark',
        copyOnSelect: true,
        rightClickPaste: true,
      },
      appearance: {
        theme: 'dark',
        accentColor: '#58a6ff',
        sidebarWidth: 280,
      },
      ssh: {
        keepAliveInterval: 30,
        keepAliveCountMax: 3,
        defaultPort: 22,
        compression: false,
      },
      general: {
        startMinimized: false,
        minimizeToTray: false,
        checkUpdates: true,
        language: 'en',
      },
    };
  }

  // ─── Hosts ──────────────────────────────────────────────

  async getHosts() {
    return this._readCollection('hosts');
  }

  async saveHost(host) {
    await this._acquireLock('hosts');
    try {
      const hosts = await this._readCollection('hosts');
      if (host.id) {
        const index = hosts.findIndex(h => h.id === host.id);
        if (index !== -1) {
          hosts[index] = { ...hosts[index], ...host, updatedAt: new Date().toISOString() };
        } else {
          host.updatedAt = new Date().toISOString();
          hosts.push(host);
        }
      } else {
        host.id = crypto.randomUUID();
        host.createdAt = new Date().toISOString();
        host.updatedAt = new Date().toISOString();
        hosts.push(host);
      }
      await this._writeCollection('hosts', hosts);
      return host;
    } finally {
      this._releaseLock('hosts');
    }
  }

  /**
   * Field-level write of the detected OS (`ssh:os-detected`). Reads the host
   * as it is ON DISK under the lock and changes only `os`: a renderer copy
   * would carry stale fields over a version a sync pull just wrote. Returns
   * the updated host, or null when there is nothing to do (unknown id, same
   * os) or `isSealed()` says sync could not open this host here — a local
   * save would replace its sealed remote copy, the only readable password.
   * `isSealed` runs under the lock, where sync marks undecryptable ids.
   */
  async setHostOs(hostId, os, { isSealed } = {}) {
    if (typeof hostId !== 'string' || !hostId || typeof os !== 'string' || !os) return null;
    await this._acquireLock('hosts');
    try {
      const hosts = await this._readCollection('hosts');
      const host = hosts.find(h => h && h.id === hostId);
      if (!host || host.os === os) return null;
      if (isSealed && await isSealed(hostId)) return null;
      host.os = os;
      host.updatedAt = new Date().toISOString();
      await this._writeCollection('hosts', hosts);
      return host;
    } finally {
      this._releaseLock('hosts');
    }
  }

  /**
   * Field-level write of the host's colour (the swatch pickers). Same shape
   * as setHostOs: reads the host from disk under the lock and changes only
   * `color`. `color` is null (none) or '#rrggbb'; anything else throws. The
   * palette itself lives only in the renderer (src/components/HostList/
   * hostColor.js): main validates the format, not the list. Returns the host,
   * or null for an unknown id (quick connect) or an unchanged colour. A host
   * sync could not open here THROWS instead of being a silent no-op: the user
   * clicked a swatch and must be told why nothing changed.
   */
  async setHostColor(hostId, color, { isSealed } = {}) {
    if (typeof hostId !== 'string' || !hostId) return null;
    if (color !== null && !(typeof color === 'string' && HOST_COLOR_RE.test(color))) {
      throw new Error('Invalid color: expected null or #rrggbb');
    }
    const next = color === null ? null : color.toLowerCase();
    await this._acquireLock('hosts');
    try {
      const hosts = await this._readCollection('hosts');
      const host = hosts.find(h => h && h.id === hostId);
      if (!host) return null;
      const current = typeof host.color === 'string' && host.color ? host.color.toLowerCase() : null;
      if (current === next) return null;
      if (isSealed && await isSealed(hostId)) throw new Error(SEALED_HOST_COLOR_ERROR);
      if (next === null) delete host.color;
      else host.color = next;
      host.updatedAt = new Date().toISOString();
      await this._writeCollection('hosts', hosts);
      return host;
    } finally {
      this._releaseLock('hosts');
    }
  }

  async deleteHost(id) {
    await this._acquireLock('hosts');
    try {
      const hosts = await this._readCollection('hosts');
      const filtered = hosts.filter(h => h.id !== id);
      if (filtered.length === hosts.length) {
        return false;
      }
      await this._writeCollection('hosts', filtered);
      return true;
    } finally {
      this._releaseLock('hosts');
    }
  }

  // ─── Groups ─────────────────────────────────────────────

  async getGroups() {
    return this._readCollection('groups');
  }

  async saveGroup(group) {
    await this._acquireLock('groups');
    try {
      const groups = await this._readCollection('groups');
      if (group.id) {
        const index = groups.findIndex(g => g.id === group.id);
        if (index !== -1) {
          groups[index] = { ...groups[index], ...group, updatedAt: new Date().toISOString() };
        } else {
          group.updatedAt = new Date().toISOString();
          groups.push(group);
        }
      } else {
        group.id = crypto.randomUUID();
        group.createdAt = new Date().toISOString();
        group.updatedAt = new Date().toISOString();
        groups.push(group);
      }
      await this._writeCollection('groups', groups);
      return group;
    } finally {
      this._releaseLock('groups');
    }
  }

  async deleteGroup(id) {
    await this._acquireLock('groups');
    try {
      const groups = await this._readCollection('groups');
      const filtered = groups.filter(g => g.id !== id);
      if (filtered.length === groups.length) return false;
      await this._writeCollection('groups', filtered);
      return true;
    } finally {
      this._releaseLock('groups');
    }
  }

  // ─── Snippets ───────────────────────────────────────────

  async getSnippets() {
    return this._readCollection('snippets');
  }

  async saveSnippet(snippet) {
    await this._acquireLock('snippets');
    try {
      const snippets = await this._readCollection('snippets');
      if (snippet.id) {
        const index = snippets.findIndex(s => s.id === snippet.id);
        if (index !== -1) {
          snippets[index] = { ...snippets[index], ...snippet, updatedAt: new Date().toISOString() };
        } else {
          snippet.updatedAt = new Date().toISOString();
          snippets.push(snippet);
        }
      } else {
        snippet.id = crypto.randomUUID();
        snippet.createdAt = new Date().toISOString();
        snippet.updatedAt = new Date().toISOString();
        snippets.push(snippet);
      }
      await this._writeCollection('snippets', snippets);
      return snippet;
    } finally {
      this._releaseLock('snippets');
    }
  }

  async deleteSnippet(id) {
    await this._acquireLock('snippets');
    try {
      const snippets = await this._readCollection('snippets');
      const filtered = snippets.filter(s => s.id !== id);
      if (filtered.length === snippets.length) return false;
      await this._writeCollection('snippets', filtered);
      return true;
    } finally {
      this._releaseLock('snippets');
    }
  }

  // ─── Keys ───────────────────────────────────────────────

  async getKeys() {
    const keys = await this._readCollection('keys');
    // Strip private key content from listing for security
    return keys.map(k => ({
      ...k,
      privateKey: k.privateKey ? '[REDACTED]' : undefined,
      hasPrivateKey: !!k.privateKey,
    }));
  }

  async getKeyWithPrivateData(id) {
    const keys = await this._readCollection('keys');
    return keys.find(k => k.id === id) || null;
  }

  async saveKey(key) {
    await this._acquireLock('keys');
    try {
      const keys = await this._readCollection('keys');
      if (key.id) {
        const index = keys.findIndex(k => k.id === key.id);
        if (index !== -1) {
          keys[index] = { ...keys[index], ...key, updatedAt: new Date().toISOString() };
        } else {
          key.updatedAt = new Date().toISOString();
          keys.push(key);
        }
      } else {
        key.id = crypto.randomUUID();
        key.createdAt = new Date().toISOString();
        key.updatedAt = new Date().toISOString();
        keys.push(key);
      }
      await this._writeCollection('keys', keys);
      // Return without private key content
      const { privateKey, ...safeKey } = key;
      return { ...safeKey, hasPrivateKey: !!privateKey };
    } finally {
      this._releaseLock('keys');
    }
  }

  async deleteKey(id) {
    await this._acquireLock('keys');
    try {
      const keys = await this._readCollection('keys');
      const filtered = keys.filter(k => k.id !== id);
      if (filtered.length === keys.length) return false;
      await this._writeCollection('keys', filtered);
      return true;
    } finally {
      this._releaseLock('keys');
    }
  }

  // ─── Port Forwards ─────────────────────────────────────

  // Rules are migrated to the current shape on READ (port-forward-rules.js),
  // not rewritten on disk: a rewrite would be a local edit of every rule and
  // sync would push them all. The file only changes shape when a rule is saved.
  // `active` is never stored: running state lives in port-forward-service.

  async getPortForwards() {
    const { normalizeRules } = require('./port-forward-rules');
    return normalizeRules(await this._readCollection('port-forwards'));
  }

  async getPortForward(id) {
    return (await this.getPortForwards()).find(f => f.id === id) || null;
  }

  async savePortForward(forward) {
    const { normalizeRule } = require('./port-forward-rules');
    if (!forward || typeof forward !== 'object') throw new Error('Invalid port forwarding rule');
    await this._acquireLock('port-forwards');
    try {
      const forwards = await this._readCollection('port-forwards');
      const now = new Date().toISOString();
      let saved;
      const index = forward.id ? forwards.findIndex(f => f && f.id === forward.id) : -1;
      if (index !== -1) {
        saved = normalizeRule({ ...forwards[index], ...forward, updatedAt: now });
        forwards[index] = saved;
      } else {
        saved = normalizeRule({
          ...forward,
          id: forward.id || crypto.randomUUID(),
          createdAt: forward.createdAt || now,
          updatedAt: now,
        });
        forwards.push(saved);
      }
      await this._writeCollection('port-forwards', forwards);
      return saved;
    } finally {
      this._releaseLock('port-forwards');
    }
  }

  async deletePortForward(id) {
    await this._acquireLock('port-forwards');
    try {
      const forwards = await this._readCollection('port-forwards');
      const filtered = forwards.filter(f => f.id !== id);
      if (filtered.length === forwards.length) return false;
      await this._writeCollection('port-forwards', filtered);
      return true;
    } finally {
      this._releaseLock('port-forwards');
    }
  }

  // ─── Known hosts (synced as `known_hosts`, row-encrypted like keys) ─
  //
  // { id, host, port, keyType, key, fingerprint, addedAt }. host lowercased;
  // one host:port may hold several key types. Matching lives in known-hosts.js.
  // Entries are immutable: accepting again makes a new id, so sync never has
  // to merge two versions of one entry. After sync a host:port+keyType can hold
  // several keys (two devices accepted different ones): any of them matches.

  async getKnownHosts() {
    return this._readCollection('known-hosts');
  }

  /**
   * Store an accepted host key. `replaceAll` (the user accepted a CHANGED key)
   * drops every entry of that host:port first: the old identity is not trusted
   * any more, whatever its key type. Otherwise only the same key type is
   * replaced and other types are kept.
   */
  async saveKnownHost(entry, { replaceAll = false } = {}) {
    const { hostKeyId } = require('./known-hosts');
    await this._acquireLock('known-hosts');
    try {
      const list = await this._readCollection('known-hosts');
      const id = hostKeyId(entry.host, entry.port);
      const kept = list.filter(e => hostKeyId(e.host, e.port) !== id
        || (!replaceAll && e.keyType !== entry.keyType));
      const saved = {
        id: crypto.randomUUID(),
        host: String(entry.host).toLowerCase(),
        port: Number(entry.port) || 22,
        keyType: entry.keyType,
        key: entry.key,
        fingerprint: entry.fingerprint,
        addedAt: entry.addedAt || new Date().toISOString(),
      };
      kept.push(saved);
      await this._writeCollection('known-hosts', kept);
      return saved;
    } finally {
      this._releaseLock('known-hosts');
    }
  }

  /** Adds entries not already present (same host:port + keyType). */
  async addKnownHosts(entries) {
    const { hostKeyId } = require('./known-hosts');
    await this._acquireLock('known-hosts');
    try {
      const list = await this._readCollection('known-hosts');
      const seen = new Set(list.map(e => `${hostKeyId(e.host, e.port)} ${e.keyType}`));
      let added = 0;
      let duplicates = 0;
      const now = new Date().toISOString();
      for (const entry of entries) {
        const tag = `${hostKeyId(entry.host, entry.port)} ${entry.keyType}`;
        if (seen.has(tag)) { duplicates++; continue; }
        seen.add(tag);
        list.push({
          id: crypto.randomUUID(),
          host: String(entry.host).toLowerCase(),
          port: Number(entry.port) || 22,
          keyType: entry.keyType,
          key: entry.key,
          fingerprint: entry.fingerprint,
          addedAt: now,
        });
        added++;
      }
      if (added) await this._writeCollection('known-hosts', list);
      return { added, duplicates };
    } finally {
      this._releaseLock('known-hosts');
    }
  }

  async deleteKnownHost(id) {
    await this._acquireLock('known-hosts');
    try {
      const list = await this._readCollection('known-hosts');
      const filtered = list.filter(e => e.id !== id);
      if (filtered.length === list.length) return false;
      await this._writeCollection('known-hosts', filtered);
      return true;
    } finally {
      this._releaseLock('known-hosts');
    }
  }

  // ─── Connection logs (synced as `connection_logs`, plaintext) ─
  //
  // Written only by connection-log-service. Never commands, output or secrets.
  // Every write stamps `updatedAt`: sync is last-writer-wins on it, and without
  // it a re-pull from 0 would put back the start-only copy over a local end.

  async getConnectionLogs() {
    return this._readCollection('connection-logs');
  }

  async addConnectionLog(entry, cap) {
    await this._acquireLock('connection-logs');
    try {
      const list = await this._readCollection('connection-logs');
      const saved = { ...entry, updatedAt: entry.updatedAt || new Date().toISOString() };
      list.push(saved);
      await this._writeCollection('connection-logs', capConnectionLogs(list, cap));
      return saved;
    } finally {
      this._releaseLock('connection-logs');
    }
  }

  /** Merges `patch` into the entry. `endedAt` is never overwritten once set. */
  async updateConnectionLog(id, patch) {
    await this._acquireLock('connection-logs');
    try {
      const list = await this._readCollection('connection-logs');
      const entry = list.find(e => e.id === id);
      if (!entry) return null;
      const next = { ...patch };
      if (entry.endedAt && 'endedAt' in next) delete next.endedAt;
      if (!Object.keys(next).some(k => entry[k] !== next[k])) return entry;
      Object.assign(entry, next, { updatedAt: new Date().toISOString() });
      await this._writeCollection('connection-logs', list);
      return entry;
    } finally {
      this._releaseLock('connection-logs');
    }
  }

  async clearConnectionLogs() {
    await this._acquireLock('connection-logs');
    try {
      await this._writeCollection('connection-logs', []);
      return true;
    } finally {
      this._releaseLock('connection-logs');
    }
  }

  /**
   * Quit path: stamp `endedAt` on the given open entries under the
   * collection lock, so it cannot interleave with an in-flight async write
   * (last rename wins, and the loser's stamps or new entry were lost). If
   * the lock is not free within `lockMs`, falls back to the synchronous
   * write: quitting must not hang on it.
   */
  async closeConnectionLogs(ids, endedAt, { lockMs = 1500 } = {}) {
    if (!ids || !ids.length) return 0;
    if (!(await this._tryAcquireLock('connection-logs', lockMs))) {
      return this.closeConnectionLogsSync(ids, endedAt);
    }
    try {
      return this.closeConnectionLogsSync(ids, endedAt);
    } finally {
      this._releaseLock('connection-logs');
    }
  }

  /**
   * The unlocked synchronous stamp-and-write (last resort on quit; normally
   * called by closeConnectionLogs with the lock held).
   * Unique temp name so it can never rename an async writer's file away.
   */
  closeConnectionLogsSync(ids, endedAt) {
    if (!ids || !ids.length) return 0;
    const filePath = this._getFilePath('connection-logs');
    let list;
    try {
      list = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (_) {
      return 0;
    }
    if (!Array.isArray(list)) return 0;
    const open = new Set(ids);
    let n = 0;
    for (const entry of list) {
      if (open.has(entry.id) && !entry.endedAt) { entry.endedAt = endedAt; entry.updatedAt = endedAt; n++; }
    }
    if (!n) return 0;
    const tempPath = `${filePath}.${process.pid}.quit.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(list, null, 2), 'utf-8');
    fs.renameSync(tempPath, filePath);
    return n;
  }

  // ─── Raw collection access (sync engine only) ───────────

  /**
   * The unfiltered contents of a collection file, private key material included.
   * `getKeys()` redacts; the sync engine needs the real thing to encrypt it
   * before it leaves the machine. Do not expose this over IPC.
   * @param {string} collection - file name without .json ('port-forwards', not 'port_forwards')
   */
  async readRaw(collection) {
    return this._readCollection(collection);
  }

  /**
   * Read-modify-write of a whole collection under its lock (sync pull).
   * `fn(items)` returns the new array to write, or null/undefined to leave the
   * file alone. Do not call other store methods on the same collection from
   * inside `fn`: the lock is not reentrant.
   */
  async mutateRaw(collection, fn) {
    await this._acquireLock(collection);
    try {
      const current = await this._readCollection(collection);
      const next = await fn(Array.isArray(current) ? current : []);
      if (Array.isArray(next)) await this._writeCollection(collection, next, { fromSync: true });
      return next;
    } finally {
      this._releaseLock(collection);
    }
  }

  /** Replaces a whole collection, under the same lock as the normal writers. */
  async writeRaw(collection, items) {
    await this._acquireLock(collection);
    try {
      await this._writeCollection(collection, items, { fromSync: true });
      return items.length;
    } finally {
      this._releaseLock(collection);
    }
  }

  // ─── Settings ───────────────────────────────────────────

  async getSettings() {
    const defaults = this._getDefaultSettings();
    const saved = await this._purgeAiCredentials(await this._readSettings());
    // Deep merge saved over defaults so new default keys are picked up
    return this._deepMerge(defaults, saved);
  }

  async saveSettings(settings) {
    const current = await this.getSettings();
    const merged = this._deepMerge(current, settings);
    // Belt and braces: never let an `ai` block back onto disk, whatever the
    // caller sends. See _purgeAiCredentials.
    delete merged.ai;
    await this._writeSettings(merged);
    return merged;
  }

  /**
   * The AI assistant is gone, but users who ran an earlier build still have its
   * provider API keys sitting in plaintext in settings.json. Drop the whole `ai`
   * block and rewrite the file the first time settings are read, so the keys
   * stop living on disk. Idempotent: once there is no `ai` key, nothing is
   * written. A failed rewrite is logged, not thrown — settings must still load.
   */
  async _purgeAiCredentials(saved) {
    if (!saved || typeof saved !== 'object') return saved;
    if (!Object.prototype.hasOwnProperty.call(saved, 'ai')) return saved;

    delete saved.ai;
    try {
      await this._writeSettings(saved);
    } catch (err) {
      console.error('[StoreService] Could not purge stored AI credentials:', err.message);
    }
    return saved;
  }

  _deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source)) {
      if (
        source[key] &&
        typeof source[key] === 'object' &&
        !Array.isArray(source[key]) &&
        target[key] &&
        typeof target[key] === 'object' &&
        !Array.isArray(target[key])
      ) {
        result[key] = this._deepMerge(target[key], source[key]);
      } else {
        result[key] = source[key];
      }
    }
    return result;
  }
}

module.exports = new StoreService();
