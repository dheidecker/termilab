const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, safeStorage } = require('electron');

/**
 * Secrets for the sync engine: the 32-byte master key that end-to-end encrypts
 * the `keys` collection, and the device token minted by the sync API.
 *
 * Both live in `<userData>/data/sync-secrets.json`, but never in the clear: the
 * values are wrapped with Electron's `safeStorage`, which delegates to the OS
 * keychain (Keychain / libsecret / DPAPI). No extra native dependency, no
 * keytar. If the platform cannot encrypt (headless Linux without a secret
 * service, mostly) we refuse to store anything rather than write plaintext.
 *
 * Record encryption is AES-256-GCM with a fresh 12-byte nonce PER RECORD. The
 * 16-byte auth tag is appended to the ciphertext, so `ciphertext` on the wire is
 * `enc || tag`.
 */

const SECRETS_FILE = 'sync-secrets.json';
const MASTER_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

class CryptoService {
  constructor() {
    this._cache = null; // { masterKey: Buffer|null, token: string|null }
    this._writeSeq = 0;
    this._dataDir = null;
  }

  // ─── Plumbing ───────────────────────────────────────────

  _dir() {
    if (!this._dataDir) {
      this._dataDir = path.join(app.getPath('userData'), 'data');
    }
    return this._dataDir;
  }

  _file() {
    return path.join(this._dir(), SECRETS_FILE);
  }

  /**
   * True when the OS keychain is usable. Everything that persists a secret
   * checks this first; readers tolerate `false` and simply report "no secrets".
   */
  isEncryptionAvailable() {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch (_) {
      return false;
    }
  }

  _requireEncryption() {
    if (!this.isEncryptionAvailable()) {
      throw new Error(
        'El almacen de claves del sistema no esta disponible, asi que no se puede ' +
        'guardar la clave maestra ni el token de forma segura. En Linux hace falta ' +
        'un servicio de secretos (gnome-keyring o kwallet) en marcha.'
      );
    }
  }

  _wrap(value) {
    this._requireEncryption();
    return safeStorage.encryptString(value).toString('base64');
  }

  _unwrap(b64) {
    if (!b64) return null;
    try {
      return safeStorage.decryptString(Buffer.from(b64, 'base64'));
    } catch (err) {
      // Wrong machine, wrong user, or a rotated keychain entry. Treat as absent
      // rather than exploding: the user can log in and pair again.
      console.error('[CryptoService] No se pudo descifrar un secreto guardado:', err.message);
      return null;
    }
  }

  async _read() {
    if (this._cache) return this._cache;
    let raw = null;
    try {
      raw = JSON.parse(await fsp.readFile(this._file(), 'utf-8'));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('[CryptoService] sync-secrets.json ilegible:', err.message);
      }
      raw = {};
    }
    const masterKeyB64 = raw.masterKey ? this._unwrap(raw.masterKey) : null;
    let masterKey = null;
    if (masterKeyB64) {
      const buf = Buffer.from(masterKeyB64, 'base64');
      if (buf.length === MASTER_KEY_BYTES) masterKey = buf;
    }
    this._cache = {
      masterKey,
      token: raw.token ? this._unwrap(raw.token) : null,
    };
    return this._cache;
  }

  async _write(next) {
    this._requireEncryption();
    await fsp.mkdir(this._dir(), { recursive: true });
    const payload = {
      version: 1,
      masterKey: next.masterKey ? this._wrap(next.masterKey.toString('base64')) : null,
      token: next.token ? this._wrap(next.token) : null,
    };
    const file = this._file();
    const tmp = `${file}.${process.pid}.${++this._writeSeq}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf-8', mode: 0o600 });
      await fsp.rename(tmp, file);
      try { await fsp.chmod(file, 0o600); } catch (_) { /* windows */ }
    } catch (err) {
      try { await fsp.unlink(tmp); } catch (_) { /* ignore */ }
      throw err;
    }
    this._cache = { masterKey: next.masterKey || null, token: next.token || null };
  }

  // ─── Master key ─────────────────────────────────────────

  async hasMasterKey() {
    const s = await this._read();
    return !!s.masterKey;
  }

  async getMasterKey() {
    const s = await this._read();
    return s.masterKey;
  }

  /** Returns the master key, generating one on first use. */
  async ensureMasterKey() {
    const s = await this._read();
    if (s.masterKey) return s.masterKey;
    this._requireEncryption();
    const masterKey = crypto.randomBytes(MASTER_KEY_BYTES);
    await this._write({ ...s, masterKey });
    return masterKey;
  }

  /** Installs a master key received through pairing. Overwrites the local one. */
  async setMasterKey(keyBuffer) {
    const buf = Buffer.isBuffer(keyBuffer) ? keyBuffer : Buffer.from(keyBuffer, 'base64');
    if (buf.length !== MASTER_KEY_BYTES) {
      throw new Error(`La clave maestra debe medir ${MASTER_KEY_BYTES} bytes, llegaron ${buf.length}`);
    }
    const s = await this._read();
    await this._write({ ...s, masterKey: buf });
    return buf;
  }

  // ─── Device token ───────────────────────────────────────

  async getToken() {
    const s = await this._read();
    return s.token;
  }

  async setToken(token) {
    const s = await this._read();
    await this._write({ ...s, token: token || null });
  }

  async clearToken() {
    const s = await this._read();
    await this._write({ ...s, token: null });
  }

  /** Forgets everything, master key included. Only for an explicit reset. */
  async clearAll() {
    this._cache = { masterKey: null, token: null };
    try {
      fs.unlinkSync(this._file());
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  // ─── Record encryption ──────────────────────────────────

  /**
   * @param {object|string} value
   * @param {Buffer} [key] - defaults to the stored master key
   * @returns {Promise<{ciphertext: string, nonce: string}>} both base64
   */
  async encryptRecord(value, key) {
    const masterKey = key || (await this.getMasterKey());
    if (!masterKey) throw new Error('No hay clave maestra para cifrar');
    const plaintext = typeof value === 'string' ? value : JSON.stringify(value);
    return this.encryptWith(masterKey, plaintext);
  }

  /** Same as encryptRecord but with an explicit key and a string/Buffer input. */
  encryptWith(key, plaintext) {
    if (!Buffer.isBuffer(key) || key.length !== MASTER_KEY_BYTES) {
      throw new Error('La clave de cifrado debe ser un Buffer de 32 bytes');
    }
    const nonce = crypto.randomBytes(NONCE_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const body = Buffer.concat([
      cipher.update(Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf-8')),
      cipher.final(),
    ]);
    // Tag travels appended to the ciphertext; the server only sees opaque bytes.
    return {
      ciphertext: Buffer.concat([body, cipher.getAuthTag()]).toString('base64'),
      nonce: nonce.toString('base64'),
    };
  }

  /** @returns {Promise<string>} the plaintext */
  async decryptRecord(ciphertextB64, nonceB64, key) {
    const masterKey = key || (await this.getMasterKey());
    if (!masterKey) throw new Error('No hay clave maestra para descifrar');
    return this.decryptWith(masterKey, ciphertextB64, nonceB64);
  }

  decryptWith(key, ciphertextB64, nonceB64) {
    if (!Buffer.isBuffer(key) || key.length !== MASTER_KEY_BYTES) {
      throw new Error('La clave de cifrado debe ser un Buffer de 32 bytes');
    }
    const raw = Buffer.from(ciphertextB64, 'base64');
    const nonce = Buffer.from(nonceB64, 'base64');
    if (nonce.length !== NONCE_BYTES) throw new Error('Nonce invalido');
    if (raw.length < TAG_BYTES + 1) throw new Error('Ciphertext invalido');
    const body = raw.subarray(0, raw.length - TAG_BYTES);
    const tag = raw.subarray(raw.length - TAG_BYTES);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf-8');
  }

  /** Convenience: decrypt straight into an object. */
  async decryptJson(ciphertextB64, nonceB64, key) {
    return JSON.parse(await this.decryptRecord(ciphertextB64, nonceB64, key));
  }
}

module.exports = new CryptoService();
module.exports.MASTER_KEY_BYTES = MASTER_KEY_BYTES;
module.exports.NONCE_BYTES = NONCE_BYTES;
