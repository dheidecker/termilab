/**
 * How OpenSSH writes a known host: `host` on port 22, `[host]:port` otherwise.
 * Duplicated from electron/services/known-hosts.js `displayHost` (main is
 * CommonJS, the renderer ESM). Change both or neither.
 */
export function displayHost(host, port) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  const p = Number(port) || 22;
  return p === 22 ? h : `[${h}]:${p}`;
}

/* "ssh-ed25519" -> "ED25519", "ecdsa-sha2-nistp256" -> "ECDSA P-256" */
export function keyTypeLabel(type) {
  const t = String(type || '');
  if (t === 'ssh-ed25519') return 'ED25519';
  if (t === 'ssh-rsa') return 'RSA';
  if (t === 'ssh-dss') return 'DSA';
  const ec = t.match(/^ecdsa-sha2-nistp(\d+)$/);
  if (ec) return `ECDSA P-${ec[1]}`;
  if (t.startsWith('sk-ssh-ed25519')) return 'ED25519-SK';
  if (t.startsWith('sk-ecdsa')) return 'ECDSA-SK';
  return t || 'Unknown';
}
