/**
 * Shared helpers for the Sync UI.
 *
 * Everything here is defensive on purpose: the main process is the only source
 * of these payloads and the renderer must survive a missing `window.electronAPI
 * .sync`, a handler that rejects, and a status object that arrives partially
 * filled (the `sync:status` push events do not have to repeat every field).
 */

/** Normalize whatever came back from `sync.status()` / `sync.onStatus`. */
export function normalizeSyncStatus(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const pending = Array.isArray(s.pendingPairings)
    ? s.pendingPairings.length
    : Number(s.pendingPairings) || 0;
  return {
    signedIn: !!s.signedIn,
    email: s.email || null,
    deviceName: s.deviceName || null,
    lastSyncAt: s.lastSyncAt ?? null,
    cursor: s.cursor ?? null,
    hasMasterKey: !!s.hasMasterKey,
    /* Account passphrase vault. `unlocked` is what the UI decides on: only an
       unlocked computer can open and back up secrets. `hasMasterKey` only says
       that some key is installed, and every older install has a random one. */
    vaultExists: !!s.vaultExists,
    unlocked: !!s.unlocked,
    undecryptableCount: toCount(s.undecryptableCount),
    undecryptableIds: Array.isArray(s.undecryptableIds)
      ? s.undecryptableIds.filter(x => typeof x === 'string')
      : [],
    pendingPairings: pending,
    syncing: !!s.syncing,
    error: readError(s.error),
    /* Field-level secrets from the last sync. `withheld` did not go up (no
       master key to encrypt them with), `blocked` came down sealed and this
       device cannot open them. Neither means data was lost. */
    secretsWithheld: toCount(s.secretsWithheld),
    secretsBlocked: toCount(s.secretsBlocked),
    /* Not in the base IPC contract: the main process also reports the pairing
       this device started, because the six digits are not known when
       pairing.request() returns — they only exist once the other device
       answers, and they arrive on this push. Optional on purpose: the panel
       works without it, it just cannot show the digits. */
    pairing: normalizePairing(s.pairing),
  };
}

/* Counters arrive as numbers, but a status push that predates the field, or a
   string from a hand-written payload, must not print "NaN hosts". */
function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function normalizePairing(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.id || raw.pairingId || null;
  if (!id) return null;
  /* `state` is one of the Spanish strings the main process documents:
     'pendiente' (nobody accepted yet, no digits), 'verificar' (digits are on
     both screens and the master key has NOT been sent), 'listo' (the other
     side confirmed, the sealed key is waiting for claim()), 'rejected',
     'expired'. PairingClaim branches on these literally. */
  return { id, digits: raw.digits || null, state: raw.state || null };
}

/* An error that crossed IPC may arrive as a string, as an Error, or as a
   stripped `{}` that stringifies to "[object Object]". */
function readError(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value.message === 'string' && value.message) return value.message;
  const text = String(value);
  return text === '[object Object]' ? 'Sync reported an error' : text;
}

/** Unwrap `{devices:[...]}`, a bare array, or garbage. */
export function toDeviceList(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.devices) ? raw.devices : [];
  return list.filter(d => d && typeof d === 'object');
}

/** Unwrap `{pending:[...]}`, a bare array, or garbage. */
export function toPendingList(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.pending) ? raw.pending : [];
  return list.filter(p => p && typeof p === 'object');
}

/** Six digits as an array of characters, padded so the layout never jumps. */
export function toDigits(value) {
  const clean = String(value ?? '').replace(/\D/g, '').slice(0, 6);
  return clean.padEnd(6, '•').split('');
}

/** An error from an IPC rejection, a string, or nothing at all. */
export function errorMessage(err, fallback) {
  if (!err) return fallback;
  if (typeof err === 'string') return err;
  return err.message || fallback;
}

const PLATFORM_LABELS = {
  darwin: 'macOS',
  mac: 'macOS',
  macos: 'macOS',
  win32: 'Windows',
  windows: 'Windows',
  linux: 'Linux',
};

export function platformLabel(platform) {
  if (!platform) return 'Unknown platform';
  const key = String(platform).toLowerCase();
  return PLATFORM_LABELS[key] || String(platform);
}

/**
 * "3 minutes ago" for anything date-like: ISO string, epoch millis, epoch
 * seconds, or a Date. Returns null when it cannot make sense of the input,
 * so callers can fall back to their own copy instead of printing "Invalid Date".
 */
export function formatRelative(value) {
  const date = toDate(value);
  if (!date) return null;
  const diff = Date.now() - date.getTime();
  if (diff < 0) return 'just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins === 1) return '1 minute ago';
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.floor(mins / 60);
  if (hours === 1) return '1 hour ago';
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return date.toLocaleDateString();
}

export function formatAbsolute(value) {
  const date = toDate(value);
  if (!date) return null;
  return date.toLocaleString();
}

function toDate(value) {
  /* 0 is not a date here: it is a "never synced" field that leaked a default,
     and printing 31/12/1969 for it is worse than printing nothing. */
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    /* Epoch seconds vs millis: anything below this is not a plausible ms date. */
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (value.trim() !== '' && !isNaN(numeric)) return toDate(numeric);
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}
