/**
 * The other Termilabs in the owner's tailnet (web mirror, PC switcher).
 *
 * Every desktop Termilab with Remote access on serves the mirror at
 * https://<dnsName>:<DEFAULT_PORT>/ through `tailscale serve`. To list them:
 *
 *  1. `tailscale status --json` (tailscale.statusJson): the `Peer` map.
 *  2. Keep the peers that are Online, untagged, not shared in from someone
 *     else, and owned by the same user as Self (`UserID === Self.UserID`).
 *  3. GET https://<peer>:<port>/.well-known/termilab on each, in parallel
 *     with a limit and a short timeout. Only a 200 JSON `{app:'termilab'}`
 *     counts; anything else (another service, a 403, a timeout) is left out.
 *
 * Auth: the probe goes out of this PC without any identity header, and
 * server.js answers /.well-known/termilab only to the owner. That still works
 * because `tailscale serve` on the peer stamps Tailscale-User-Login itself on
 * every request that reaches it over the tailnet from an untagged node, from
 * that node's owner (https://tailscale.com/kb/1312/serve, "Identity headers":
 * populated for tailnet traffic, not for tagged devices nor Funnel, and
 * incoming copies are stripped). Our probe comes from an untagged node of the
 * same user (step 2 plus remote-access refusing a tagged Self), so the peer
 * sees the owner's login. No unauthenticated endpoint is needed.
 *
 * TLS: the peer's certificate is a real Let's Encrypt one issued through
 * Tailscale, so verification stays the Node default. Tests inject an `agent`
 * that trusts their own CA; nothing here ever turns verification off.
 *
 * Result: [{name, dnsName, url, self, version}], Self first, cached `ttlMs`.
 */
const https = require('https');
const tailscale = require('./tailscale');

const TIMEOUT_MS = 2000;
const CONCURRENCY = 6;
const TTL_MS = 60000;
const MAX_BODY = 4096;
const MAX_NAME = 64;
const MAX_VERSION = 32;

const DNS_RE = /^[a-z0-9]([a-z0-9-]{0,62})(\.[a-z0-9]([a-z0-9-]{0,62}))+$/i;

const cleanDns = (s) => String(s || '').trim().replace(/\.$/, '').toLowerCase();
const cleanStr = (s, max) => (typeof s === 'string' && s.trim() ? s.trim().slice(0, max) : null);
const urlOf = (dnsName, port) => (port === 443 ? `https://${dnsName}/` : `https://${dnsName}:${port}/`);

/**
 * Pure: `tailscale status --json` → {self: {dnsName, hostName}|null, peers: [{dnsName, hostName}]}
 * Peers are only the candidates: online, untagged, same user, not shared in.
 */
function candidates(json) {
  if (!json || typeof json !== 'object' || json.BackendState !== 'Running') return { self: null, peers: [] };
  const me = json.Self || {};
  const selfDns = cleanDns(me.DNSName);
  const self = DNS_RE.test(selfDns) ? { dnsName: selfDns, hostName: cleanStr(me.HostName, MAX_NAME) } : null;
  if (me.UserID == null) return { self, peers: [] };
  const seen = new Set(self ? [self.dnsName] : []);
  const peers = [];
  for (const p of Object.values(json.Peer || {})) {
    if (!p || typeof p !== 'object') continue;
    if (p.Online !== true) continue;
    if (Array.isArray(p.Tags) && p.Tags.length) continue;
    if (p.ShareeNode) continue;
    if (p.UserID == null || String(p.UserID) !== String(me.UserID)) continue;
    const dnsName = cleanDns(p.DNSName);
    if (!DNS_RE.test(dnsName) || seen.has(dnsName)) continue;
    seen.add(dnsName);
    peers.push({ dnsName, hostName: cleanStr(p.HostName, MAX_NAME) });
  }
  return { self, peers };
}

/** GET /.well-known/termilab on one peer → {name, version} or null. Never throws. */
function probe(dnsName, { port = tailscale.DEFAULT_PORT, timeoutMs = TIMEOUT_MS, agent } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    let req;
    const timer = setTimeout(() => { finish(null); if (req) req.destroy(); }, timeoutMs);
    try {
      req = https.get({
        host: dnsName,
        servername: dnsName,
        port,
        path: '/.well-known/termilab',
        headers: { Accept: 'application/json' },
        agent,
      }, (res) => {
        const type = String(res.headers['content-type'] || '');
        if (res.statusCode !== 200 || !/^application\/json\b/i.test(type)) { res.resume(); finish(null); req.destroy(); return; }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => {
          body += d;
          if (body.length > MAX_BODY) { finish(null); req.destroy(); }
        });
        res.on('end', () => {
          let info;
          try { info = JSON.parse(body); } catch (_) { finish(null); return; }
          if (!info || typeof info !== 'object' || info.app !== 'termilab') { finish(null); return; }
          finish({ name: cleanStr(info.name, MAX_NAME), version: cleanStr(info.version, MAX_VERSION) });
        });
        res.on('error', () => finish(null));
      });
      req.on('error', () => finish(null));
    } catch (_) {
      finish(null);
    }
  });
}

/** Runs fn over items, at most `limit` at a time; results in input order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * @param {object} [deps]
 * @param {(opts?) => Promise<object|null>} [deps.statusJson]  default tailscale.statusJson
 * @param {number} [deps.port]         default tailscale.DEFAULT_PORT
 * @param {number} [deps.timeoutMs]    per probe
 * @param {number} [deps.concurrency]
 * @param {number} [deps.ttlMs]
 * @param {() => number} [deps.now]
 * @param {https.Agent} [deps.agent]   tests only: an agent trusting their CA
 */
function createDiscovery(deps = {}) {
  const statusJson = deps.statusJson || tailscale.statusJson;
  const port = Number.isInteger(deps.port) ? deps.port : tailscale.DEFAULT_PORT;
  const timeoutMs = deps.timeoutMs || TIMEOUT_MS;
  const concurrency = deps.concurrency || CONCURRENCY;
  const ttlMs = deps.ttlMs == null ? TTL_MS : deps.ttlMs;
  const now = deps.now || Date.now;
  const agent = deps.agent;
  let cache = null;      // {at, key, list}
  let inflight = null;   // {key, promise}

  async function discover({ selfName, selfVersion }) {
    const { self, peers } = candidates(await statusJson());
    const found = await mapLimit(peers, concurrency, async (p) => {
      const info = await probe(p.dnsName, { port, timeoutMs, agent });
      if (!info) return null;
      return {
        name: info.name || p.hostName || p.dnsName.split('.')[0],
        dnsName: p.dnsName,
        url: urlOf(p.dnsName, port),
        self: false,
        version: info.version,
      };
    });
    const others = found.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
    if (!self) return others;
    return [{
      name: cleanStr(selfName, MAX_NAME) || self.hostName || self.dnsName.split('.')[0],
      dnsName: self.dnsName,
      url: urlOf(self.dnsName, port),
      self: true,
      version: cleanStr(selfVersion, MAX_VERSION),
    }, ...others];
  }

  /** The list, from cache when fresh. `force` skips the cache. */
  async function peers({ selfName = null, selfVersion = null, force = false } = {}) {
    const key = JSON.stringify([selfName, selfVersion]);
    if (!force && cache && cache.key === key && now() - cache.at < ttlMs) return cache.list.map(x => ({ ...x }));
    if (!force && inflight && inflight.key === key) return (await inflight.promise).map(x => ({ ...x }));
    const promise = discover({ selfName, selfVersion });
    inflight = { key, promise };
    try {
      const list = await promise;
      cache = { at: now(), key, list };
      return list.map(x => ({ ...x }));
    } finally {
      if (inflight && inflight.promise === promise) inflight = null;
    }
  }

  return { peers, clear: () => { cache = null; } };
}

const shared = createDiscovery();

module.exports = {
  createDiscovery, candidates, probe, mapLimit,
  peers: (opts) => shared.peers(opts),
  clear: () => shared.clear(),
  TIMEOUT_MS, TTL_MS, CONCURRENCY,
};
