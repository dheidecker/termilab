/**
 * Known hosts: the pure half (no Electron, no disk, no timers), so the arnés
 * can test it directly.
 *
 * - `keyInfo(blob)`: key type + OpenSSH SHA256 fingerprint of a raw SSH
 *   public key blob (what ssh2 hands the hostVerifier when no hostHash is set).
 * - `parseKnownHosts(text)`: the plain entries of an OpenSSH known_hosts file.
 * - `decide(entries, host, port, blob)`: accept silently, or prompt and why.
 *
 * Entries are keyed by `host:port` with the host lowercased (see `hostKeyId`).
 * A host:port may hold several entries of different key types (an imported
 * known_hosts usually has ed25519 + rsa + ecdsa for the same server).
 *
 * Synced across devices, so a host:port + keyType may ALSO hold several keys:
 * two devices each accepted a different one before they synced. The rule is
 * deterministic and the same on every device:
 *   - ANY stored key for host:port matching the presented one -> accept;
 *   - 'changed' only when none matches but that key type is known (the
 *     previous fingerprint shown is the most recently added of that type);
 *   - 'new-key-type' when none matches and only other key types are known;
 *   - accepting a 'changed' key drops every entry of that host:port
 *     (store-service `saveKnownHost` replaceAll), on every device via sync.
 * Identical entries (same host:port, type and key; different ids) collapse to
 * the smallest id (`dedupeEntries`), which every device picks alike.
 */

const crypto = require('crypto');

/* Plain public key types we accept from known_hosts. Certificates
   (*-cert-v01@openssh.com) and @cert-authority lines are not supported. */
const KEY_TYPES = new Set([
  'ssh-ed25519',
  'ssh-rsa',
  'ssh-dss',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com',
]);

function normalizeHost(host) {
  let h = String(host || '').trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  return h;
}

function normalizePort(port) {
  const n = Number(port);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 22;
}

/** `host:port`, host lowercased. The identity of a known host. */
function hostKeyId(host, port) {
  return `${normalizeHost(host)}:${normalizePort(port)}`;
}

/** How OpenSSH writes it: `host` on 22, `[host]:port` otherwise. */
function displayHost(host, port) {
  const h = normalizeHost(host);
  const p = normalizePort(port);
  return p === 22 ? h : `[${h}]:${p}`;
}

/** SHA256:<unpadded base64>, byte for byte what `ssh-keygen -lf` prints. */
function fingerprint(blob) {
  return `SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

/** The type string an SSH key blob starts with (uint32 length + ascii). */
function blobKeyType(blob) {
  if (!Buffer.isBuffer(blob) || blob.length < 4) return null;
  const len = blob.readUInt32BE(0);
  if (len <= 0 || len > 64 || blob.length < 4 + len) return null;
  const type = blob.toString('latin1', 4, 4 + len);
  return /^[\x21-\x7e]+$/.test(type) ? type : null;
}

function keyInfo(blob) {
  return { keyType: blobKeyType(blob), fingerprint: fingerprint(blob), key: blob.toString('base64') };
}

/* A single host pattern from the first field: `host` or `[host]:port`.
   Wildcards and negations are patterns, not hosts: unsupported. */
function parseHostPattern(pattern) {
  if (!pattern || /[*?!]/.test(pattern)) return null;
  const bracket = pattern.match(/^\[([^\]]+)\]:(\d+)$/);
  if (bracket) {
    const port = Number(bracket[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host: normalizeHost(bracket[1]), port };
  }
  if (pattern.includes('[') || pattern.includes(']')) return null;
  return { host: normalizeHost(pattern), port: 22 };
}

/**
 * Parse known_hosts text. Returns
 *   { entries: [{host, port, keyType, key, fingerprint}], skipped, reasons }
 * where `skipped` counts lines that yielded nothing and `reasons` splits them
 * into hashed / unsupported / malformed. Blank lines and comments do not count.
 */
function parseKnownHosts(text) {
  const entries = [];
  const reasons = { hashed: 0, unsupported: 0, malformed: 0 };
  const lines = String(text || '').split(/\r?\n/);

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const fields = line.split(/\s+/);
    if (fields[0].startsWith('@')) {
      if (fields[0] === '@cert-authority' || fields[0] === '@revoked') reasons.unsupported++;
      else reasons.malformed++;
      continue;
    }
    if (fields.length < 3) { reasons.malformed++; continue; }

    const [hostsField, keyType, keyB64] = fields;
    if (hostsField.startsWith('|')) { reasons.hashed++; continue; }
    if (keyType.endsWith('-cert-v01@openssh.com')) { reasons.unsupported++; continue; }
    if (!KEY_TYPES.has(keyType)) { reasons.malformed++; continue; }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(keyB64)) { reasons.malformed++; continue; }

    const blob = Buffer.from(keyB64, 'base64');
    if (blobKeyType(blob) !== keyType) { reasons.malformed++; continue; }

    const fp = fingerprint(blob);
    const key = blob.toString('base64');
    let added = 0;
    for (const pattern of hostsField.split(',')) {
      const hp = parseHostPattern(pattern);
      if (!hp || !hp.host) continue;
      entries.push({ host: hp.host, port: hp.port, keyType, key, fingerprint: fp });
      added++;
    }
    if (!added) reasons.unsupported++;
  }

  const skipped = reasons.hashed + reasons.unsupported + reasons.malformed;
  return { entries, skipped, reasons };
}

/** Entries stored for this host:port. */
function entriesFor(entries, host, port) {
  const id = hostKeyId(host, port);
  return (entries || []).filter(e => hostKeyId(e.host, e.port) === id);
}

/**
 * The verifier's decision, with no side effects.
 *   { action: 'accept', entry }
 *   { action: 'prompt', reason: 'unknown' }                     nothing known for host:port
 *   { action: 'prompt', reason: 'changed', previousFingerprint } same type, other key
 *   { action: 'prompt', reason: 'new-key-type', knownTypes, knownFingerprints }
 *       host:port is known, but only by OTHER key types. Just as suspicious as
 *       'changed' (an attacker that offers only ECDSA for a host known by
 *       ed25519 lands here), so the UI treats it the same way; accepting ADDS
 *       the key and keeps the others. `hostKeyAlgorithms` makes it rare: a
 *       known type is asked for first.
 */
function decide(entries, host, port, blob) {
  const info = keyInfo(blob);
  const mine = entriesFor(entries, host, port);
  const match = mine.find(e => e.key === info.key);
  if (match) return { action: 'accept', entry: match, ...info };

  // Several of that type (synced from devices that disagree): the newest, with
  // the id as tie-break, so every device names the same previous key.
  const sameType = mine
    .filter(e => e.keyType === info.keyType)
    .sort((a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || ''))
      || String(a.id || '').localeCompare(String(b.id || '')))[0];
  if (sameType) {
    return { action: 'prompt', reason: 'changed', previousFingerprint: sameType.fingerprint, ...info };
  }
  if (mine.length) {
    return {
      action: 'prompt',
      reason: 'new-key-type',
      knownTypes: [...new Set(mine.map(e => e.keyType))],
      knownFingerprints: mine.map(e => ({ keyType: e.keyType, fingerprint: e.fingerprint })),
      ...info,
    };
  }
  return { action: 'prompt', reason: 'unknown', ...info };
}

/* Stored key type -> the ssh2 host key algorithm names that negotiate it. */
const ALGORITHMS_BY_KEY_TYPE = {
  'ssh-ed25519': ['ssh-ed25519'],
  'ssh-rsa': ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'],
  'ssh-dss': ['ssh-dss'],
  'ecdsa-sha2-nistp256': ['ecdsa-sha2-nistp256'],
  'ecdsa-sha2-nistp384': ['ecdsa-sha2-nistp384'],
  'ecdsa-sha2-nistp521': ['ecdsa-sha2-nistp521'],
};

/**
 * ssh2 `algorithms.serverHostKey` for host:port: the algorithms of the key
 * types already stored for it first, then `defaults` (ssh2's own list) in its
 * order. Only names in `supported` (ssh2 throws on anything else). null when
 * nothing is known, or nothing known maps to a supported algorithm: then ssh2
 * keeps its default list.
 */
function hostKeyAlgorithms(entries, host, port, defaults, supported) {
  const ok = new Set(supported || defaults || []);
  const first = [];
  for (const e of entriesFor(entries, host, port)) {
    for (const algo of ALGORITHMS_BY_KEY_TYPE[e.keyType] || []) {
      if (ok.has(algo) && !first.includes(algo)) first.push(algo);
    }
  }
  if (!first.length) return null;
  return [...first, ...(defaults || []).filter(a => ok.has(a) && !first.includes(a))];
}

/**
 * Collapses entries with the same host:port, key type and key to the one with
 * the smallest id, keeping array order. Pure: callers decide what to write.
 */
function dedupeEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const winner = new Map();
  const tagOf = e => `${hostKeyId(e.host, e.port)} ${e.keyType} ${e.key}`;
  for (const e of list) {
    if (!e || !e.key) continue;
    const tag = tagOf(e);
    const cur = winner.get(tag);
    if (!cur || String(e.id) < String(cur.id)) winner.set(tag, e);
  }
  return list.filter(e => !e || !e.key || winner.get(tagOf(e)) === e);
}

module.exports = {
  KEY_TYPES,
  normalizeHost,
  normalizePort,
  hostKeyId,
  displayHost,
  fingerprint,
  blobKeyType,
  keyInfo,
  parseKnownHosts,
  entriesFor,
  decide,
  hostKeyAlgorithms,
  dedupeEntries,
};
