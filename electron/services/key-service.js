const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const storeService = require('./store-service');

class KeyService {
  constructor() {}

  /**
   * Import an SSH private key from the filesystem.
   * @param {string} filePath - Absolute path to the private key file
   * @returns {Promise<object>} - The saved key metadata
   */
  async importKey(filePath) {
    try {
      const privateKeyContent = await fsp.readFile(filePath, 'utf-8');

      // Validate it looks like a private key
      if (!this._isValidPrivateKey(privateKeyContent)) {
        throw new Error('The selected file does not appear to be a valid SSH private key');
      }

      const keyName = path.basename(filePath);
      const keyType = this._detectKeyType(privateKeyContent);

      // Try to read the corresponding public key if it exists
      let publicKey = null;
      const pubKeyPath = `${filePath}.pub`;
      try {
        publicKey = await fsp.readFile(pubKeyPath, 'utf-8');
        publicKey = publicKey.trim();
      } catch (_) {
        // Public key file doesn't exist, that's fine
      }

      // Extract fingerprint if possible
      let fingerprint = null;
      try {
        fingerprint = this._computeFingerprint(privateKeyContent);
      } catch (_) {
        // Fingerprint extraction failed, that's fine
      }

      const key = {
        name: keyName,
        type: keyType,
        privateKey: privateKeyContent,
        publicKey,
        fingerprint,
        source: 'imported',
        importedFrom: filePath,
      };

      return await storeService.saveKey(key);
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error(`Key file not found: ${filePath}`);
      }
      if (err.code === 'EACCES') {
        throw new Error(`Permission denied reading key file: ${filePath}`);
      }
      throw err;
    }
  }

  /**
   * Generate a new SSH key pair.
   * @param {object} options
   * @param {string} options.name - Display name for the key
   * @param {string} [options.type='ed25519'] - Key type: 'ed25519' or 'rsa'
   * @param {number} [options.bits=4096] - RSA key size in bits (only for RSA)
   * @param {string} [options.passphrase] - Optional passphrase to encrypt the private key
   * @param {string} [options.comment] - Optional comment for the key
   * @returns {Promise<object>} - The saved key metadata
   */
  async generateKey(options = {}) {
    const {
      name,
      label,
      type: rawType = 'ed25519',
      bits = 4096,
      passphrase,
      comment,
    } = options;

    // Accept either 'name' or 'label' from the caller
    const keyName = name || label || 'generated-key';
    // Normalize type to lowercase (renderer may send 'ED25519', 'RSA', etc.)
    const type = rawType.toLowerCase();

    let privateKey, publicKey;

    if (type === 'ed25519') {
      const keyPair = crypto.generateKeyPairSync('ed25519', {
        publicKeyEncoding: {
          type: 'spki',
          format: 'pem',
        },
        privateKeyEncoding: {
          type: 'pkcs8',
          format: 'pem',
          ...(passphrase ? { cipher: 'aes-256-cbc', passphrase } : {}),
        },
      });
      privateKey = keyPair.privateKey;
      publicKey = this._convertToOpenSSHPublicKey(keyPair.publicKey, 'ed25519', comment);
    } else if (type === 'rsa') {
      const keyPair = crypto.generateKeyPairSync('rsa', {
        modulusLength: bits,
        publicKeyEncoding: {
          type: 'spki',
          format: 'pem',
        },
        privateKeyEncoding: {
          type: 'pkcs8',
          format: 'pem',
          ...(passphrase ? { cipher: 'aes-256-cbc', passphrase } : {}),
        },
      });
      privateKey = keyPair.privateKey;
      publicKey = this._convertToOpenSSHPublicKey(keyPair.publicKey, 'rsa', comment);
    } else {
      throw new Error(`Unsupported key type: ${type}. Supported types: ed25519, rsa`);
    }

    let fingerprint = null;
    try {
      fingerprint = this._computeFingerprint(privateKey);
    } catch (_) {
      // Fingerprint computation failed, not critical
    }

    const key = {
      name: keyName || `${type}-key-${Date.now()}`,
      type,
      privateKey,
      publicKey,
      fingerprint,
      source: 'generated',
      hasPassphrase: !!passphrase,
      comment: comment || '',
      ...(type === 'rsa' ? { bits } : {}),
    };

    return await storeService.saveKey(key);
  }

  /**
   * Get the full private key content for a key by ID.
   * Used internally when establishing SSH connections with a stored key.
   */
  async getPrivateKey(keyId) {
    const key = await storeService.getKeyWithPrivateData(keyId);
    if (!key) {
      throw new Error(`Key not found: ${keyId}`);
    }
    return key.privateKey;
  }

  _isValidPrivateKey(content) {
    const trimmed = content.trim();
    return (
      trimmed.includes('-----BEGIN') &&
      trimmed.includes('PRIVATE KEY-----') &&
      trimmed.includes('-----END')
    );
  }

  _detectKeyType(privateKeyContent) {
    const content = privateKeyContent.trim();
    if (content.includes('BEGIN OPENSSH PRIVATE KEY')) {
      // OpenSSH format — peek at the key type inside
      // This is a simplified detection
      if (content.length < 600) return 'ed25519';
      return 'rsa'; // heuristic: RSA keys are much longer
    }
    if (content.includes('BEGIN RSA PRIVATE KEY') || content.includes('BEGIN PRIVATE KEY')) {
      return 'rsa';
    }
    if (content.includes('BEGIN EC PRIVATE KEY')) {
      return 'ecdsa';
    }
    if (content.includes('BEGIN DSA PRIVATE KEY')) {
      return 'dsa';
    }
    return 'unknown';
  }

  _computeFingerprint(privateKeyContent) {
    // Create a SHA-256 hash of the key material for identification
    const hash = crypto.createHash('sha256').update(privateKeyContent.trim()).digest('hex');
    // Format as colon-separated pairs (first 32 chars = 16 bytes)
    const shortened = hash.substring(0, 32);
    return shortened.match(/.{2}/g).join(':');
  }

  _convertToOpenSSHPublicKey(pemPublicKey, keyType, comment) {
    try {
      const keyObj = crypto.createPublicKey(pemPublicKey);
      const sshPublicKey = keyObj.export({ type: 'spki', format: 'der' });
      const base64Key = sshPublicKey.toString('base64');
      const typePrefix = keyType === 'ed25519' ? 'ssh-ed25519' : 'ssh-rsa';
      const commentSuffix = comment ? ` ${comment}` : ` ${os.userInfo().username}@${os.hostname()}`;
      return `${typePrefix} ${base64Key}${commentSuffix}`;
    } catch (_) {
      // Fallback: return PEM format if conversion fails
      return pemPublicKey;
    }
  }

  /**
   * Get the default SSH key directory.
   */
  getDefaultKeyPath() {
    return path.join(os.homedir(), '.ssh');
  }
}

module.exports = new KeyService();
