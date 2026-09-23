/**
 * Duplicate hosts: the same endpoint saved more than once — usually created on
 * two computers before they synced. Sync identifies a host by its id, never by
 * its address, so it cannot notice this on its own.
 *
 * Pure functions, no React: the review panel and AppContext both use them.
 */

const norm = (s) => String(s ?? '').trim();

/** `user@host:port`, or null for a host with no address. */
export function endpointKey(host) {
  const hostname = norm(host && host.hostname).toLowerCase();
  if (!hostname) return null;
  const port = Number(host.port) || 22;
  /* Hostnames are case-insensitive; usernames are not on the server side. */
  return `${norm(host.username)}@${hostname}:${port}`;
}

export function hasCredential(host) {
  return host.authType === 'key' ? !!host.keyId : !!host.password;
}

/* Keep the one that can actually connect, then the organised one, then the
   oldest — the oldest is the one other computers have known longest. */
export function rankForKeeping(a, b) {
  return (Number(hasCredential(b)) - Number(hasCredential(a)))
    || (Number(!!b.groupId) - Number(!!a.groupId))
    || String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
}

/** Groups of two or more hosts sharing an endpoint, best candidate first. */
export function findDuplicateGroups(hosts) {
  const byKey = new Map();
  for (const host of hosts || []) {
    const key = endpointKey(host);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(host);
  }
  return [...byKey.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([key, list]) => ({ key, hosts: [...list].sort(rankForKeeping) }));
}

/**
 * The host to keep, plus whatever the others add: a group if it has none, the
 * union of tags, and a credential if it lacks one. Its own values always win —
 * nothing it already has is overwritten.
 */
export function mergeInto(survivor, others) {
  const merged = { ...survivor };
  for (const other of others) {
    if (!merged.groupId && other.groupId) merged.groupId = other.groupId;
    if (!hasCredential(merged) && hasCredential(other)) {
      merged.authType = other.authType;
      if (other.authType === 'key') {
        merged.keyId = other.keyId;
        if (other.passphrase) merged.passphrase = other.passphrase;
      } else {
        merged.password = other.password;
      }
    }
  }
  const tags = new Set([survivor, ...others].flatMap(h => (Array.isArray(h.tags) ? h.tags : [])));
  merged.tags = [...tags];
  return merged;
}

/**
 * A host whose password arrived sealed with a key this computer does not have
 * shows up here with no password at all — indistinguishable from "never had
 * one". The other computer still holds the readable copy, and a delete from
 * here propagates there: merging it away would destroy that copy. Refuse the
 * whole group until that computer re-seals it with the account passphrase.
 */
export function sealedMembers(group, undecryptableIds) {
  const sealed = new Set(undecryptableIds || []);
  return group.hosts.filter(h => sealed.has(`hosts/${h.id}`));
}
