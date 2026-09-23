const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const { app, safeStorage } = require('electron');

const scryptAsync = promisify(crypto.scrypt);

/**
 * Secrets for the sync engine: the 32-byte master key that end-to-end encrypts
 * the `keys` collection, and the device token minted by the sync API.
 *
 * The master key is NEVER generated at random any more. It is derived from the
 * user's passphrase (scrypt) with the salt of the account's vault record, and a
 * key only counts as "unlocked" when it opens that record's verifier. One key
 * per account, so two devices can no longer end up sealing with different keys.
 * A key installed before vaults existed (or received by pairing with no vault)
 * is a LEGACY key: it can still read, but the sync engine never seals with it,
 * and when the account key is installed it is kept in `legacyKeys` only until
 * everything it can open has been re-sealed and uploaded.
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

// ─── Vault (passphrase -> master key) ─────────────────────
const VAULT_VERSION = 1;
const VAULT_SALT_BYTES = 16;
const PASSPHRASE_MIN_CHARS = 6;
const DEFAULT_KDF = Object.freeze({ alg: 'scrypt', N: 131072, r: 8, p: 1 });
// N=2^17, r=8 needs ~128 MiB; Node's default maxmem (32 MiB) throws
// "memory limit exceeded" without this.
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
// Bounds for parameters READ FROM THE RECORD, which comes from the server: a
// forged record must not be able to hang or starve the app.
const KDF_LIMITS = Object.freeze({ minN: 1 << 14, maxN: 1 << 20, maxR: 32, maxP: 16 });
/** Known plaintext sealed with the derived key. Opening it = right passphrase. */
const VERIFIER_PLAINTEXT = 'termilab-vault-verifier/v1';

const ERR_PASSPHRASE_SHORT = `El passphrase debe tener al menos ${PASSPHRASE_MIN_CHARS} caracteres`;
const ERR_VAULT_INVALID = 'El registro de la boveda es invalido';

function dedupeKeys(keys) {
  const out = [];
  for (const k of keys) {
    if (!Buffer.isBuffer(k) || k.length !== MASTER_KEY_BYTES) continue;
    if (!out.some(o => o.equals(k))) out.push(k);
  }
  return out;
}

class CryptoService {
  constructor() {
    // { masterKey: Buffer|null, token: string|null, vaultSalt: string|null,
    //   legacyKeys: Buffer[] }
    this._cache = null;
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
    const legacyKeys = [];
    for (const wrapped of Array.isArray(raw.legacyKeys) ? raw.legacyKeys : []) {
      const b64 = this._unwrap(wrapped);
      const buf = b64 ? Buffer.from(b64, 'base64') : null;
      if (buf && buf.length === MASTER_KEY_BYTES) legacyKeys.push(buf);
    }
    this._cache = {
      masterKey,
      token: raw.token ? this._unwrap(raw.token) : null,
      // The salt of the vault the master key was derived for. null = legacy key.
      vaultSalt: masterKey && typeof raw.vaultSalt === 'string' ? raw.vaultSalt : null,
      legacyKeys,
    };
    return this._cache;
  }

  async _write(next) {
    this._requireEncryption();
    await fsp.mkdir(this._dir(), { recursive: true });
    const legacyKeys = dedupeKeys(next.legacyKeys || []);
    const payload = {
      version: 1,
      masterKey: next.masterKey ? this._wrap(next.masterKey.toString('base64')) : null,
      token: next.token ? this._wrap(next.token) : null,
      vaultSalt: next.masterKey && next.vaultSalt ? next.vaultSalt : null,
      legacyKeys: legacyKeys.map(k => this._wrap(k.toString('base64'))),
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
    this._cache = {
      masterKey: next.masterKey || null,
      token: next.token || null,
      vaultSalt: next.masterKey && next.vaultSalt ? next.vaultSalt : null,
      legacyKeys,
    };
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

  /**
   * Installs a master key. Overwrites the local one: callers that must not
   * orphan what the old key sealed pass it in `legacyKeys`.
   *
   * @param {Buffer|string} keyBuffer
   * @param {{vaultSalt?: string|null, legacyKeys?: Buffer[]}} [opts]
   *   `vaultSalt` = salt of the vault this key was derived for (null = legacy).
   *   `legacyKeys` defaults to the ones already stored.
   */
  async setMasterKey(keyBuffer, { vaultSalt = null, legacyKeys } = {}) {
    const buf = Buffer.isBuffer(keyBuffer) ? keyBuffer : Buffer.from(keyBuffer, 'base64');
    if (buf.length !== MASTER_KEY_BYTES) {
      throw new Error(`La clave maestra debe medir ${MASTER_KEY_BYTES} bytes, llegaron ${buf.length}`);
    }
    const s = await this._read();
    const legacy = (legacyKeys === undefined ? s.legacyKeys : legacyKeys)
      .filter(k => Buffer.isBuffer(k) && k.length === MASTER_KEY_BYTES && !k.equals(buf));
    await this._write({ ...s, masterKey: buf, vaultSalt: vaultSalt || null, legacyKeys: legacy });
    return buf;
  }

  /** Salt of the vault the installed key belongs to, or null (legacy / none). */
  async getVaultSalt() {
    const s = await this._read();
    return s.vaultSalt;
  }

  /** Old keys kept only until what they sealed has been re-sealed and uploaded. */
  async getLegacyKeys() {
    const s = await this._read();
    return s.legacyKeys.slice();
  }

  async clearLegacyKeys() {
    const s = await this._read();
    if (!s.legacyKeys.length) return;
    await this._write({ ...s, legacyKeys: [] });
  }

  // ─── Vault: passphrase-derived master key ───────────────

  /**
   * R9: validated here, in main, whatever the UI did. NEVER put the passphrase
   * in an error message or a log line.
   */
  validatePassphrase(passphrase) {
    if (typeof passphrase !== 'string' || [...passphrase].length < PASSPHRASE_MIN_CHARS) {
      throw new Error(ERR_PASSPHRASE_SHORT);
    }
    // Same passphrase typed on macOS and on Windows must give the same bytes.
    return passphrase.normalize('NFC');
  }

  /**
   * Normalises a vault record that came from the server. Returns null if it is
   * not a well-formed v1 record, so a malformed row cannot crash a sync.
   */
  parseVault(raw) {
    if (!raw || typeof raw !== 'object' || raw.v !== VAULT_VERSION) return null;
    if (typeof raw.salt !== 'string') return null;
    if (Buffer.from(raw.salt, 'base64').length !== VAULT_SALT_BYTES) return null;
    const kdf = raw.kdf;
    if (!kdf || kdf.alg !== 'scrypt') return null;
    const { N, r, p } = kdf;
    if (!Number.isInteger(N) || N < KDF_LIMITS.minN || N > KDF_LIMITS.maxN || (N & (N - 1)) !== 0) return null;
    if (!Number.isInteger(r) || r < 1 || r > KDF_LIMITS.maxR) return null;
    if (!Number.isInteger(p) || p < 1 || p > KDF_LIMITS.maxP) return null;
    const verifier = raw.verifier;
    if (!verifier || typeof verifier.ciphertext !== 'string' || typeof verifier.nonce !== 'string') return null;
    return {
      v: VAULT_VERSION,
      salt: raw.salt,
      kdf: { alg: 'scrypt', N, r, p },
      verifier: { ciphertext: verifier.ciphertext, nonce: verifier.nonce },
    };
  }

  /** Derives the master key with the salt and KDF parameters OF THE RECORD. */
  async deriveVaultKey(passphrase, vaultRecord) {
    const normalized = this.validatePassphrase(passphrase);
    const vault = this.parseVault(vaultRecord);
    if (!vault) throw new Error(ERR_VAULT_INVALID);
    const { N, r, p } = vault.kdf;
    return scryptAsync(normalized, Buffer.from(vault.salt, 'base64'), MASTER_KEY_BYTES, {
      N, r, p, maxmem: SCRYPT_MAXMEM,
    });
  }

  /** True when `key` opens the record's verifier. Cheap: one AES-GCM open. */
  verifyVaultKey(key, vaultRecord) {
    const vault = this.parseVault(vaultRecord);
    if (!vault || !Buffer.isBuffer(key) || key.length !== MASTER_KEY_BYTES) return false;
    try {
      return this.decryptWith(key, vault.verifier.ciphertext, vault.verifier.nonce) === VERIFIER_PLAINTEXT;
    } catch (_) {
      return false;
    }
  }

  /**
   * A brand-new vault: fresh salt, default KDF, verifier sealed with the
   * derived key. Stores nothing; the caller decides when to install the key.
   * @returns {Promise<{vault: object, key: Buffer}>}
   */
  async createVault(passphrase) {
    this.validatePassphrase(passphrase);
    const draft = {
      v: VAULT_VERSION,
      salt: crypto.randomBytes(VAULT_SALT_BYTES).toString('base64'),
      kdf: { ...DEFAULT_KDF },
    };
    const key = await this.deriveVaultKey(passphrase, {
      ...draft,
      verifier: { ciphertext: '', nonce: '' },
    });
    return { vault: { ...draft, verifier: this.encryptWith(key, VERIFIER_PLAINTEXT) }, key };
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
    this._cache = { masterKey: null, token: null, vaultSalt: null, legacyKeys: [] };
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
module.exports.PASSPHRASE_MIN_CHARS = PASSPHRASE_MIN_CHARS;
module.exports.ERR_PASSPHRASE_SHORT = ERR_PASSPHRASE_SHORT;
