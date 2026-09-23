/**
 * Host key verification (TOFU, like OpenSSH): the shared hostVerifier for
 * ssh-service and port-forward-service.
 *
 *   known + same key      -> accept silently
 *   unknown               -> ask the user
 *   same type, other key  -> ask with reason 'changed' (the UI defaults to Cancel)
 *   only other types known-> ask with reason 'new-key-type' (treated like
 *                            'changed' by the UI; accepting ADDS the key)
 *
 * Asking is the only main -> renderer -> main round trip in the app:
 *   main pushes  'ssh:host-key-prompt'   {requestId, host, port, keyType, fingerprint, reason, ...}
 *   renderer     invoke('ssh:host-key-response', {requestId, accept})
 *   main pushes  'ssh:host-key-prompt-cancel' {requestId} when it gives up
 *                (timeout, connection gone) so the modal closes.
 * No window, a destroyed window, a timeout or a failed send all REJECT.
 *
 * Concurrent connections to the same host:port share one prompt when they saw
 * the same key; a different key waits for the first prompt and is re-decided
 * against the store afterwards (so an accept there usually settles it).
 * A waiting connection counts as "a human is deciding" (its timeouts pause)
 * and stays cancellable: if it dies while queued it resolves false at once
 * and, when its turn comes, never prompts and never writes.
 */

const crypto = require('crypto');
const storeService = require('./store-service');
const { decide, hostKeyAlgorithms, hostKeyId, normalizeHost, normalizePort } = require('./known-hosts');

const PROMPT_TIMEOUT_MS = 120 * 1000;

class HostKeyService {
  constructor() {
    this.mainWindow = null;
    this.timeoutMs = PROMPT_TIMEOUT_MS;
    /** requestId -> { id, hostId, fingerprint, payload, waiters:Set, timer, resolve, promise, replaceAll, info } */
    this._pending = new Map();
    /** host:port -> tail of the per-host chain */
    this._chains = new Map();
  }

  setMainWindow(win) {
    this.mainWindow = win;
  }

  _windowAlive() {
    try {
      return !!(this.mainWindow && !this.mainWindow.isDestroyed()
        && this.mainWindow.webContents && !(this.mainWindow.webContents.isDestroyed?.()));
    } catch (_) {
      return false;
    }
  }

  _send(channel, payload) {
    if (!this._windowAlive()) return false;
    try {
      this.mainWindow.webContents.send(channel, payload);
      return true;
    } catch (err) {
      console.error(`[HostKeyService] Failed to send ${channel}:`, err.message);
      return false;
    }
  }

  /**
   * Decide on `blob` for host:port. Resolves true (accept) or false (reject);
   * never throws. `hooks.onPrompt()` / `hooks.onSettled()` let the caller
   * pause its own connection timeout while a human is reading the dialog.
   * `hooks.handle`, if given, gets a `cancel()` the caller invokes when its
   * connection dies before the user answered (the dialog closes if nobody
   * else is waiting on it).
   */
  async verify(host, port, blob, hooks = {}) {
    const h = normalizeHost(host);
    const p = normalizePort(port);
    const hostId = hostKeyId(h, p);

    /* Same key already being asked about: join that prompt, don't queue. */
    for (const req of this._pending.values()) {
      if (req.hostId === hostId && req.info.key === blob.toString('base64')) {
        return this._join(req, hooks);
      }
    }

    /* onPrompt/onSettled at most once each, whether the pause starts while
       queued or when our own dialog opens. */
    let paused = false;
    let resumed = false;
    const gated = {
      onPrompt: () => {
        if (paused) return;
        paused = true;
        try { hooks.onPrompt?.(); } catch (_) { /* caller's problem */ }
      },
      onSettled: () => {
        if (!paused || resumed) return;
        resumed = true;
        try { hooks.onSettled?.(); } catch (_) { /* ignore */ }
      },
      handle: hooks.handle,
    };

    /* Cancellable while queued: the connection died before its turn. */
    let cancelled = false;
    let cancelWait;
    const whenCancelled = new Promise(r => { cancelWait = () => r(false); });
    if (hooks.handle) hooks.handle.cancel = () => { cancelled = true; cancelWait(); };

    const run = async () => {
      if (cancelled) return false;
      let entries;
      try {
        entries = await storeService.getKnownHosts();
      } catch (err) {
        console.error('[HostKeyService] Could not read known hosts:', err.message);
        return false;
      }
      if (cancelled) return false;
      const d = decide(entries, h, p, blob);
      if (d.action === 'accept') return true;
      if (!d.keyType) return false;
      /* From here _join owns handle.cancel (leave the shared prompt). */
      return this._prompt(hostId, h, p, d, gated);
    };

    const prev = this._chains.get(hostId);
    const mine = (prev || Promise.resolve()).catch(() => {}).then(run);
    const tail = mine.catch(() => {});
    this._chains.set(hostId, tail);
    tail.then(() => { if (this._chains.get(hostId) === tail) this._chains.delete(hostId); });
    /* Queued behind another dialog: a human is deciding, pause our timeouts. */
    if (prev) gated.onPrompt();
    try {
      return await Promise.race([mine, whenCancelled]);
    } catch (err) {
      console.error('[HostKeyService] verify failed:', err.message);
      return false;
    } finally {
      gated.onSettled();
    }
  }

  /**
   * ssh2 `algorithms.serverHostKey` for host:port: the key types already
   * trusted for it first, so a server that has several keys presents one we
   * know instead of a new type. null (ssh2 default list) when nothing is known.
   */
  async algorithmsFor(host, port) {
    try {
      const { DEFAULT_SERVER_HOST_KEY, SUPPORTED_SERVER_HOST_KEY } = require('ssh2/lib/protocol/constants');
      const entries = await storeService.getKnownHosts();
      return hostKeyAlgorithms(entries, host, port, DEFAULT_SERVER_HOST_KEY, SUPPORTED_SERVER_HOST_KEY);
    } catch (err) {
      console.error('[HostKeyService] Could not order host key algorithms:', err.message);
      return null;
    }
  }

  _join(req, hooks) {
    const waiter = { hooks };
    req.waiters.add(waiter);
    if (hooks.handle) hooks.handle.cancel = () => this._leave(req, waiter);
    try { hooks.onPrompt?.(); } catch (_) { /* caller's problem */ }
    return req.promise.finally(() => {
      try { hooks.onSettled?.(); } catch (_) { /* ignore */ }
    });
  }

  _leave(req, waiter) {
    if (!req.waiters.delete(waiter)) return;
    if (req.waiters.size === 0) this._finish(req.id, false, 'cancelled');
  }

  _prompt(hostId, host, port, decision, hooks) {
    if (!this._windowAlive()) return false;

    const requestId = crypto.randomUUID();
    const payload = {
      requestId,
      host,
      port,
      keyType: decision.keyType,
      fingerprint: decision.fingerprint,
      reason: decision.reason,
    };
    if (decision.reason === 'changed') payload.previousFingerprint = decision.previousFingerprint;
    if (decision.knownTypes && decision.knownTypes.length) payload.knownTypes = decision.knownTypes;
    if (decision.knownFingerprints && decision.knownFingerprints.length) payload.knownFingerprints = decision.knownFingerprints;

    let resolve;
    const promise = new Promise(r => { resolve = r; });
    const req = {
      id: requestId,
      hostId,
      info: decision,
      payload,
      waiters: new Set(),
      resolve,
      promise,
      timer: null,
    };
    this._pending.set(requestId, req);
    /* Not unref'd: a pending question must keep the process alive until it
       is answered or expires (the arnés exits mid-await otherwise). */
    req.timer = setTimeout(() => this._finish(requestId, false, 'timeout'), this.timeoutMs);

    const joined = this._join(req, hooks);
    if (!this._send('ssh:host-key-prompt', payload)) {
      this._finish(requestId, false, 'no-window');
    }
    return joined;
  }

  /** Renderer's answer. Accepting stores (or, for 'changed', replaces) the key;
      for 'new-key-type' it is added next to the other types. */
  async respond(requestId, accept) {
    const req = this._pending.get(requestId);
    if (!req) return false;
    if (accept) {
      try {
        await storeService.saveKnownHost({
          host: req.payload.host,
          port: req.payload.port,
          keyType: req.info.keyType,
          key: req.info.key,
          fingerprint: req.info.fingerprint,
        }, { replaceAll: req.payload.reason === 'changed' });
      } catch (err) {
        /* Could not remember it: still let this connection through, the user
           said yes. Next time it asks again. */
        console.error('[HostKeyService] Could not save known host:', err.message);
      }
    }
    this._finish(requestId, !!accept, accept ? 'accepted' : 'rejected');
    return true;
  }

  _finish(requestId, accepted, why) {
    const req = this._pending.get(requestId);
    if (!req) return;
    this._pending.delete(requestId);
    clearTimeout(req.timer);
    if (why !== 'accepted' && why !== 'rejected') {
      this._send('ssh:host-key-prompt-cancel', { requestId, reason: why });
    }
    req.resolve(accepted);
  }

  /** Window closing / app quitting: reject everything still open. */
  rejectAll() {
    for (const id of [...this._pending.keys()]) this._finish(id, false, 'no-window');
  }

  /**
   * An ssh2 `hostVerifier(key, verify)` bound to one connection. Returns
   * { hostVerifier, cancel, wasRejected, isPending } — call cancel() when the
   * connection dies before the user answered, wasRejected() to word the
   * error, and isPending() to know a decision was still open when it died.
   */
  createVerifier(host, port, { onPrompt, onSettled } = {}) {
    const handle = { cancel: () => {} };
    let rejected = false;
    let pending = false;
    const hostVerifier = (key, verify) => {
      const blob = Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'hex');
      pending = true;
      this.verify(host, port, blob, { onPrompt, onSettled, handle })
        .then(ok => { pending = false; rejected = !ok; verify(!!ok); })
        .catch(() => { pending = false; rejected = true; verify(false); });
    };
    return {
      hostVerifier,
      cancel: () => handle.cancel(),
      wasRejected: () => rejected,
      isPending: () => pending,
    };
  }
}

module.exports = new HostKeyService();
module.exports.PROMPT_TIMEOUT_MS = PROMPT_TIMEOUT_MS;
