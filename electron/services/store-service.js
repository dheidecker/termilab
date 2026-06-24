const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

class StoreService {
  constructor() {
    this.dataDir = path.join(app.getPath('userData'), 'data');
    this._initialized = false;
    this._fileLocks = new Map();
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

  async _writeCollection(collection, data) {
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

  async _writeSettings(settings) {
    await this._ensureDataDir();
    const filePath = this._getFilePath('settings');
    const tempPath = `${filePath}.tmp`;
    try {
      await fsp.writeFile(tempPath, JSON.stringify(settings, null, 2), 'utf-8');
      await fsp.rename(tempPath, filePath);
    } catch (err) {
      try { await fsp.unlink(tempPath); } catch (_) { /* ignore */ }
      throw err;
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
        theme: 'dark',
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

  async getPortForwards() {
    return this._readCollection('port-forwards');
  }

  async savePortForward(forward) {
    await this._acquireLock('port-forwards');
    try {
      const forwards = await this._readCollection('port-forwards');
      if (forward.id) {
        const index = forwards.findIndex(f => f.id === forward.id);
        if (index !== -1) {
          forwards[index] = { ...forwards[index], ...forward, updatedAt: new Date().toISOString() };
        } else {
          forward.updatedAt = new Date().toISOString();
          forwards.push(forward);
        }
      } else {
        forward.id = crypto.randomUUID();
        forward.createdAt = new Date().toISOString();
        forward.updatedAt = new Date().toISOString();
        forwards.push(forward);
      }
      await this._writeCollection('port-forwards', forwards);
      return forward;
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

  // ─── Settings ───────────────────────────────────────────

  async getSettings() {
    const defaults = this._getDefaultSettings();
    const saved = await this._readSettings();
    // Deep merge saved over defaults so new default keys are picked up
    return this._deepMerge(defaults, saved);
  }

  async saveSettings(settings) {
    const current = await this.getSettings();
    const merged = this._deepMerge(current, settings);
    await this._writeSettings(merged);
    return merged;
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
