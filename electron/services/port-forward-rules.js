/**
 * Port forwarding rules: the stored shape, the migration from the old shape,
 * and validation. Pure functions, no I/O.
 *
 * DUPLICATED in src/components/PortForwarding/rules.js (the renderer cannot
 * require this file). Whoever changes one changes both, in the same commit.
 *
 * Stored rule (collection `port-forwards`, synced as plain JSON):
 *   { id, label, type: 'local'|'remote'|'dynamic', hostId, bindAddress,
 *     localPort, destHost, destPort, createdAt, updatedAt }
 *
 *   local   ssh -L  bindAddress:localPort on THIS computer  -> destHost:destPort seen from the server
 *   remote  ssh -R  bindAddress:localPort on the SERVER     -> destHost:destPort seen from this computer
 *   dynamic ssh -D  SOCKS5 on bindAddress:localPort on this computer (dest* unused)
 *
 * Running state is NOT stored: it lives in port-forward-service, in memory.
 */

const TYPES = ['local', 'remote', 'dynamic'];
const DEFAULT_BIND = '127.0.0.1';
const TYPE_LABELS = { local: 'Local', remote: 'Remote', dynamic: 'Dynamic' };

function toPort(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * Any stored shape -> the current one. Old rules (UI before 1.11) had
 * `sourcePort`, no `hostId`, and a persisted `active` flag that never meant
 * anything; they come out with `localPort`, `hostId: null` (the UI asks the
 * user to choose a host) and no `active`. Never throws.
 */
function normalizeRule(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  // eslint-disable-next-line no-unused-vars
  const { active, sourcePort, sessionId, ...rest } = raw;
  const type = TYPES.includes(raw.type) ? raw.type : 'local';
  const rule = {
    ...rest,
    type,
    label: str(raw.label) || `${TYPE_LABELS[type]} forward`,
    hostId: str(raw.hostId) || null,
    bindAddress: str(raw.bindAddress) || DEFAULT_BIND,
    localPort: toPort(raw.localPort !== undefined && raw.localPort !== null && raw.localPort !== '' ? raw.localPort : sourcePort),
    destHost: type === 'dynamic' ? '' : str(raw.destHost),
    destPort: type === 'dynamic' ? null : toPort(raw.destPort),
  };
  return rule;
}

function normalizeRules(list) {
  if (!Array.isArray(list)) return [];
  return list.map(normalizeRule).filter(Boolean);
}

/** First problem that prevents starting the rule, as a sentence; null if none. */
function ruleProblem(rule) {
  if (!rule) return 'This port forwarding rule no longer exists.';
  if (!TYPES.includes(rule.type)) return `Unknown forwarding type "${rule.type}".`;
  if (!rule.hostId) return 'Choose a host for this rule before starting it.';
  if (!toPort(rule.localPort)) {
    return rule.type === 'remote'
      ? 'The port to open on the server must be a number from 1 to 65535.'
      : 'The local port must be a number from 1 to 65535.';
  }
  if (rule.type !== 'dynamic') {
    if (!str(rule.destHost)) return 'The destination host is missing.';
    if (!toPort(rule.destPort)) return 'The destination port must be a number from 1 to 65535.';
  }
  return null;
}

module.exports = { TYPES, DEFAULT_BIND, toPort, normalizeRule, normalizeRules, ruleProblem };
