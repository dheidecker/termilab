/**
 * Port forwarding rules in the renderer: validation for the form and the
 * one-line summary on the cards.
 *
 * DUPLICATED from electron/services/port-forward-rules.js (main is CommonJS,
 * this is ESM; neither can import the other). The stored shape, the default
 * bind address and the port range must match there. Main migrates old rules
 * on read, so rules arriving here are already in the current shape; main
 * also re-validates on start and has the last word.
 */

export const TYPES = ['local', 'remote', 'dynamic'];
export const DEFAULT_BIND = '127.0.0.1';

export const TYPE_INFO = {
  local: {
    label: 'Local',
    letter: 'L',
    explain: 'Local forwarding lets you access a remote server’s listening port as though it were local.',
  },
  remote: {
    label: 'Remote',
    letter: 'R',
    explain: 'Remote forwarding opens a port on the server and sends its connections to a port reachable from this computer.',
  },
  dynamic: {
    label: 'Dynamic',
    letter: 'D',
    explain: 'Dynamic forwarding turns this computer into a SOCKS5 proxy: apps that use it reach any host through the server.',
  },
};

export function toPort(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

const PORT_RANGE = 'Use a port from 1 to 65535.';

/**
 * Per-field problems for the form (`{}` when it can be saved), plus warnings
 * that do not block saving.
 * @returns {{ errors: Record<string,string>, warnings: Record<string,string> }}
 */
export function checkRule(form, { requireHost = true } = {}) {
  const errors = {};
  const warnings = {};
  if (requireHost && !form.hostId) errors.hostId = 'Choose the host to tunnel through.';
  const lp = toPort(form.localPort);
  if (!lp) errors.localPort = PORT_RANGE;
  else if (lp < 1024) {
    warnings.localPort = form.type === 'remote'
      ? 'Ports below 1024 on the server usually need a root login there.'
      : 'Ports below 1024 need administrator privileges on this computer.';
  }
  if (form.type !== 'dynamic') {
    if (!String(form.destHost || '').trim()) errors.destHost = 'Enter a host name or address.';
    if (!toPort(form.destPort)) errors.destPort = PORT_RANGE;
  }
  if (!String(form.bindAddress || '').trim()) errors.bindAddress = 'Enter an address, e.g. 127.0.0.1.';
  return { errors, warnings };
}

/** Form state -> the rule main stores. Never carries a running flag. */
export function toRule(form) {
  const type = TYPES.includes(form.type) ? form.type : 'local';
  const rule = {
    label: String(form.label || '').trim() || `${TYPE_INFO[type].label} forward`,
    type,
    hostId: form.hostId || null,
    bindAddress: String(form.bindAddress || '').trim() || DEFAULT_BIND,
    localPort: toPort(form.localPort),
    destHost: type === 'dynamic' ? '' : String(form.destHost || '').trim(),
    destPort: type === 'dynamic' ? null : toPort(form.destPort),
  };
  if (form.id) rule.id = form.id;
  return rule;
}

const addr = (host, port) => `${host || '?'}:${port || '?'}`;

/** "127.0.0.1:8080 → db:5432" and friends. */
export function routeSummary(rule) {
  const bind = rule.bindAddress || DEFAULT_BIND;
  switch (rule.type) {
    case 'remote':
      return `server ${addr(bind, rule.localPort)} → ${addr(rule.destHost, rule.destPort)}`;
    case 'dynamic':
      return `SOCKS5 on ${addr(bind, rule.localPort)}`;
    case 'local':
    default:
      return `${addr(bind, rule.localPort)} → ${addr(rule.destHost, rule.destPort)}`;
  }
}
