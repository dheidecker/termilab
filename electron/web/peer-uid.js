/**
 * Who is on the other end of a loopback TCP connection (Linux, /proc/net/tcp).
 *
 * The web mirror listens on 127.0.0.1 and admits a connection only when the
 * peer socket belongs to uid 0, i.e. tailscaled (see server.js). The kernel
 * lists every TCP socket in /proc/net/tcp (and tcp6) with its owner's uid;
 * the peer of our accepted socket is the line whose LOCAL end is the
 * connection's remote address:port and whose REMOTE end is our local one.
 *
 * Format of a line (whitespace separated, the first one is a header):
 *   sl  local_address rem_address   st tx_queue:rx_queue tr:tm->when retrnsmt   uid ...
 *   0: 0100007F:1D14 0100007F:A1B2 01 00000000:00000000 00:00000000 00000000     0 ...
 * The address is the raw in_addr printed as host-order 32-bit words (so
 * 127.0.0.1 is 0100007F on little-endian), the port is a plain big-endian
 * number in hex. tcp6 does the same with four words; an IPv4 peer of an IPv6
 * socket shows as ::ffff:a.b.c.d.
 *
 * Only ESTABLISHED (st 01) lines count: TIME_WAIT and friends report uid 0
 * whoever owned them, and they are no live peer anyway.
 */
const fs = require('fs');
const net = require('net');
const os = require('os');

const ESTABLISHED = '01';

/** Bytes → the hex /proc prints: each 32-bit word in host order. */
function wordsHex(bytes, littleEndian) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 4) {
    const w = bytes.slice(i, i + 4);
    if (littleEndian) w.reverse();
    out += w.map(b => b.toString(16).padStart(2, '0')).join('');
  }
  return out.toUpperCase();
}

function ipv4Bytes(ip) {
  return ip.split('.').map(Number);
}

/** '127.0.0.1' | '::ffff:127.0.0.1' | '::1' → the 16 bytes of the IPv6 form. */
function ipv6Bytes(ip) {
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (net.isIPv4(ip) || v4) return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, ...ipv4Bytes(v4 ? v4[1] : ip)];
  let [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const groups = tail !== undefined ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  const bytes = [];
  for (const g of groups) { const n = parseInt(g || '0', 16); bytes.push(n >> 8, n & 0xff); }
  return bytes;
}

/**
 * Pure: 'ip:port' as /proc/net/tcp (family 4) or tcp6 (family 6) writes it,
 * or null when the address does not fit that family.
 */
function procAddr(ip, port, family, { littleEndian = os.endianness() === 'LE' } = {}) {
  const p = Number(port).toString(16).toUpperCase().padStart(4, '0');
  if (family === 4) {
    const m = /^(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (!m || !net.isIPv4(m[1])) return null;
    return `${wordsHex(ipv4Bytes(m[1]), littleEndian)}:${p}`;
  }
  if (!net.isIP(ip)) return null;
  return `${wordsHex(ipv6Bytes(ip), littleEndian)}:${p}`;
}

/**
 * Pure: the uid owning the ESTABLISHED socket whose local end is `local`
 * and remote end is `remote` (both already in procAddr() form), or null.
 * Two matching lines that disagree (cannot happen for a live 4-tuple) → null.
 */
function findUid(text, { local, remote }) {
  let uid = null;
  for (const line of String(text || '').split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 8 || !/^\d+:$/.test(f[0])) continue;
    if (f[1].toUpperCase() !== local || f[2].toUpperCase() !== remote || f[3] !== ESTABLISHED) continue;
    const u = Number(f[7]);
    if (!Number.isInteger(u)) return null;
    if (uid !== null && uid !== u) return null;
    uid = u;
  }
  return uid;
}

/**
 * The uid of the process that holds the other end of an accepted
 * connection: `remote` is socket.remoteAddress/remotePort (the peer),
 * `local` is socket.localAddress/localPort (us). Null when not found.
 * Synchronous on purpose: server.js calls it in the 'connection' event,
 * before the HTTP parser can read a byte.
 */
function peerUid(remote, local, { read = (p) => fs.readFileSync(p, 'utf-8') } = {}) {
  for (const [file, family] of [['/proc/net/tcp', 4], ['/proc/net/tcp6', 6]]) {
    const l = procAddr(remote.address, remote.port, family);
    const r = procAddr(local.address, local.port, family);
    if (!l || !r) continue;
    let text;
    try { text = read(file); } catch (_) { continue; }
    const uid = findUid(text, { local: l, remote: r });
    if (uid !== null) return uid;
  }
  return null;
}

module.exports = { procAddr, findUid, peerUid };
