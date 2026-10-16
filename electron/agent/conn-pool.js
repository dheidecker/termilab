/**
 * One SSH connection per host for the agent API, like OpenSSH's
 * ControlMaster: the first call logs in, later calls open a new channel on
 * the same client (exec, shell, and one shared SFTP channel per connection).
 *
 * - Keyed by host id plus a fingerprint of the fields that decide the login
 *   (hostname, port, user, auth type, key id, and SHA-256 of the key,
 *   passphrase and password). Editing the host changes the fingerprint: the
 *   old connection is retired (no new channels, closed when its last one
 *   ends) and the next call logs in with the new data. The pool keeps only
 *   the hash, never a secret.
 * - At most `maxChannels` channels per connection; the rest wait FIFO until
 *   their own deadline. A server that refuses a channel (sshd MaxSessions
 *   lower than ours) lowers that connection's limit to what is open now, and
 *   the refused call goes back to the head of the queue once.
 * - A dropped connection fails the calls that had a channel open (the caller
 *   words that error; nothing is retried) and retries once, on a new login,
 *   the calls that had not started yet.
 * - Closed after `idleMs` with no exec/shell channel open and no use. An
 *   open shell keeps it in use; the idle SFTP channel does not.
 *
 * Errors carry `.code`. The pool knows nothing about agents, logs or host
 * keys: `connect(conn)` (agent-service._connect) does the strict login.
 */
const crypto = require('crypto');

const DEFAULTS = {
  idleMs: 10 * 60 * 1000,
  maxChannels: 8,
  /* After a refusal the server is at its limit: give it a moment to free a
     session after a channel closes before asking for the next one. */
  settleMs: 150,
};

/* What OpenSSH and others answer when MaxSessions is reached */
const REFUSED = /open failed|administratively prohibited|too many sessions|no more sessions/i;
/* ssh2's words for "the socket is gone" when a channel is asked for */
const GONE = /^Not connected$|No response from server|server closed channel unexpectedly/i;

class PoolError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** Hash of everything that decides which login a host gets. Secrets enter only hashed. */
function fingerprint(host, conn) {
  return sha(JSON.stringify([
    conn.host, conn.port, conn.username,
    host && host.authType === 'key' ? 'key' : 'password',
    (host && host.keyId) || null,
    conn.privateKey ? sha(conn.privateKey) : null,
    conn.passphrase ? sha(conn.passphrase) : null,
    conn.password ? sha(conn.password) : null,
  ]));
}

let seq = 0;

class ConnPool {
  /**
   * @param {object} o
   * @param {(conn:object)=>Promise<import('ssh2').Client>} o.connect  strict login
   */
  constructor({ connect, idleMs, maxChannels, settleMs } = {}) {
    this.connect = connect;
    this.idleMs = idleMs || DEFAULTS.idleMs;
    this.maxChannels = maxChannels || DEFAULTS.maxChannels;
    this.settleMs = settleMs === undefined ? DEFAULTS.settleMs : settleMs;
    /** host key -> live entry */
    this.byKey = new Map();
    /** every entry not closed yet, retired ones included */
    this.all = new Set();
    this.stats = { logins: 0, drops: 0, idleCloses: 0, refusals: 0 };
    this.stopped = false;
  }

  // ─── Entries ────────────────────────────────────────────

  _entry(spec) {
    if (this.stopped) throw new PoolError('closed', 'Termilab is closing its connections.');
    let e = this.byKey.get(spec.key);
    if (e && !e.dead && e.fp !== spec.fp) { this._retire(e); e = null; }
    if (e && e.dead) e = null;
    if (!e) {
      e = {
        id: ++seq, key: spec.key, fp: spec.fp, label: spec.label,
        client: null, ready: null, dead: false, closedByUs: false, retired: false,
        open: 0,          // slots taken (exec, shell, the SFTP channel), opening ones included
        opened: 0,        // channels the server actually granted and that are still open
        active: 0,        // exec/shell channels open + SFTP operations running
        limit: this.maxChannels, lowered: false,
        queue: [], lastUsed: Date.now(), idleTimer: null,
        sftp: null, sftpOpening: null,
        opening: new Set(),   // channel requests the server has not answered yet
      };
      this.byKey.set(spec.key, e);
      this.all.add(e);
    }
    return e;
  }

  /* No new calls; it closes when what runs on it ends. */
  _retire(e) {
    if (e.retired || e.dead) return;
    e.retired = true;
    if (this.byKey.get(e.key) === e) this.byKey.delete(e.key);
    this._maybeClose(e);
  }

  _maybeClose(e) {
    if (e.dead) return;
    if (e.retired && e.active === 0 && !e.queue.length) this._close(e, 'retired');
  }

  _close(e, _why) {
    if (e.dead) return;
    e.dead = true;
    e.closedByUs = true;
    this._forget(e);
    for (const w of e.queue.splice(0)) w.fail(new PoolError('dropped', 'closed'));
    if (e.client) { try { e.client.end(); } catch (_) { /* gone */ } }
  }

  _forget(e) {
    clearTimeout(e.idleTimer);
    e.idleTimer = null;
    e.sftp = null;
    if (this.byKey.get(e.key) === e) this.byKey.delete(e.key);
    this.all.delete(e);
  }

  /* The socket went away under us. */
  _lost(e) {
    if (e.dead) return;
    e.dead = true;
    this.stats.drops++;
    this._forget(e);
    for (const w of e.queue.splice(0)) w.fail(new PoolError('dropped', 'lost'));
  }

  _touch(e) {
    e.lastUsed = Date.now();
    clearTimeout(e.idleTimer);
    e.idleTimer = null;
    if (e.dead || e.active > 0 || e.queue.length) return;
    e.idleTimer = setTimeout(() => {
      e.idleTimer = null;
      if (e.dead || e.active > 0 || e.queue.length) return;
      this.stats.idleCloses++;
      this._close(e, 'idle');
    }, this.idleMs);
    if (e.idleTimer.unref) e.idleTimer.unref();
  }

  _busy(e, d) {
    e.active += d;
    this._touch(e);
    if (d < 0) this._maybeClose(e);
  }

  // ─── Slots ──────────────────────────────────────────────

  _slot(e, deadline, front) {
    if (e.dead) return Promise.reject(new PoolError('dropped', 'lost'));
    if (e.open < e.limit && (!e.queue.length || front)) { e.open++; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const w = {
        grant: () => { clearTimeout(w.timer); resolve(); },
        fail: (err) => { clearTimeout(w.timer); reject(err); },
      };
      const ms = Math.max(0, deadline - Date.now());
      w.timer = setTimeout(() => {
        const i = e.queue.indexOf(w);
        if (i >= 0) e.queue.splice(i, 1);
        reject(new PoolError('timeout', `Timed out after ${Math.round((ms) / 1000)} s waiting for a free SSH channel to ${e.label} (${e.open} in use).`));
        this._touch(e);
        this._maybeClose(e);
      }, ms);
      if (front) e.queue.unshift(w); else e.queue.push(w);
      clearTimeout(e.idleTimer);
    });
  }

  _release(e) {
    e.open--;
    if (e.lowered && this.settleMs) setTimeout(() => this._pump(e), this.settleMs);
    else this._pump(e);
  }

  _pump(e) {
    while (!e.dead && e.queue.length && e.open < e.limit) {
      e.open++;
      e.queue.shift().grant();
    }
  }

  async _ready(e, conn) {
    if (e.client) return;
    if (!e.ready) {
      e.ready = this.connect(conn).then((client) => {
        this.stats.logins++;
        if (e.dead) { try { client.end(); } catch (_) { /* gone */ } throw new PoolError('dropped', 'closed'); }
        e.client = client;
        client.on('error', () => { /* 'close' follows */ });
        client.on('close', () => this._lost(e));
      }, (err) => {
        /* A failed login is not a drop: everyone waiting gets the same answer, no second attempt */
        e.dead = true;
        this._forget(e);
        for (const w of e.queue.splice(0)) w.fail(err);
        throw err;
      });
    }
    await e.ready;
  }

  /*
   * One attempt: slot, login, channel. Rejects with code 'dropped' (connection
   * gone before the channel opened) or 'refused' (server at its limit) for the
   * caller to retry; anything else is final.
   */
  async _attempt(e, spec, open, deadline, front, counts) {
    const t0 = Date.now();
    await this._slot(e, deadline, front);
    let held = true;
    const giveBack = () => { if (held) { held = false; this._release(e); } };
    try {
      await this._ready(e, spec.conn);
    } catch (err) { giveBack(); throw err; }
    if (e.dead) { giveBack(); throw new PoolError('dropped', 'lost'); }
    if (counts) e.active++;
    clearTimeout(e.idleTimer);
    let stream;
    const raw = new Promise((resolve, reject) => {
      try { open(e.client, (err, s) => (err ? reject(err) : resolve(s))); } catch (err) { reject(err); }
    });
    const settled = () => { e.opening.delete(raw); };
    e.opening.add(raw);
    raw.then(settled, settled);
    try {
      stream = await raw;
    } catch (err) {
      if (counts) e.active--;
      if (e.dead || GONE.test(err.message || '')) {
        giveBack();
        this._lost(e);
        throw new PoolError('dropped', 'lost');
      }
      if (REFUSED.test(err.message || '')) {
        this.stats.refusals++;
        /* Only what the server granted counts, so first let every request
           already sent get its answer (exec's callback comes after the
           channel open AND the exec request, later than a refusal). The slot
           is kept meanwhile so the queue does not rush into the same wall. */
        await Promise.allSettled([...e.opening]);
        if (e.opened >= 1) {
          e.limit = Math.min(e.limit, e.opened);
          e.lowered = true;
        }
        giveBack();
        this._touch(e);
        if (e.opened < 1) throw err;   // refused with nothing open: not a limit, a real "no"
        const r = new PoolError('refused', err.message);
        r.original = err;
        throw r;
      }
      giveBack();
      this._touch(e);
      this._maybeClose(e);
      throw err;
    }
    this._touch(e);
    e.opened++;
    let done = false;
    const release = () => {
      if (done) return;
      done = true;
      e.opened--;
      if (counts) e.active--;
      giveBack();
      this._touch(e);
      this._maybeClose(e);
    };
    stream.once('close', release);
    return { stream, entry: e, release, waitedMs: Date.now() - t0 };
  }

  async _withRetries(spec, deadline, fn) {
    let dropRetry = false;
    let refusedRetry = false;
    let front = false;
    for (;;) {
      const e = this._entry(spec);
      try {
        return await fn(e, front);
      } catch (err) {
        if (err && err.code === 'dropped' && !dropRetry && Date.now() < deadline) { dropRetry = true; continue; }
        if (err && err.code === 'refused' && !refusedRetry) { refusedRetry = true; front = true; continue; }
        if (err && err.code === 'dropped') throw new PoolError('ssh', `The SSH connection to ${spec.label} closed before the call could start.`);
        if (err && err.code === 'refused') throw err.original;
        throw err;
      }
    }
  }

  // ─── API ────────────────────────────────────────────────

  /**
   * A new channel on the host's pooled connection.
   * spec: { key, fp, label, conn }   open: (client, cb) => client.exec(..., cb)
   * Resolves { stream, entry, release, waitedMs, lost(), retire() }. The slot
   * comes back on the stream's 'close' (or release()).
   */
  async channel(spec, open, deadline) {
    const ch = await this._withRetries(spec, deadline, (e, front) => this._attempt(e, spec, open, deadline, front, true));
    ch.lost = () => ch.entry.dead && !ch.entry.closedByUs;
    ch.retire = () => this._retire(ch.entry);
    return ch;
  }

  /**
   * The host's shared SFTP channel (opened on first use, reopened after it
   * closes). Call done() when the operation ends.
   * Resolves { sftp, entry, done(), lost() }.
   */
  async sftp(spec, deadline) {
    return this._withRetries(spec, deadline, async (e, front) => {
      if (!e.sftp) {
        if (!e.sftpOpening) {
          e.sftpOpening = this._attempt(e, spec, (c, cb) => c.sftp(cb), deadline, front, false).then((ch) => {
            const s = ch.stream;
            const drop = () => { if (e.sftp === s) e.sftp = null; };
            s.on('close', drop);
            s.on('end', drop);
            s.on('error', drop);
            e.sftp = s;
          }).finally(() => { e.sftpOpening = null; });
        }
        await e.sftpOpening;
      }
      if (e.dead || !e.sftp) throw new PoolError('dropped', 'lost');
      const sftp = e.sftp;
      this._busy(e, +1);
      let done = false;
      return {
        sftp,
        entry: e,
        done: () => { if (!done) { done = true; this._busy(e, -1); } },
        lost: () => e.dead && !e.closedByUs,
        /* The channel misbehaved: drop it so the next call opens a new one */
        discard: () => { if (e.sftp === sftp) { e.sftp = null; try { sftp.end(); } catch (_) { /* gone */ } } },
      };
    });
  }

  /** Close every connection (Termilab quits). */
  closeAll() {
    this.stopped = true;
    for (const e of [...this.all]) this._close(e, 'quit');
    this.byKey.clear();
  }

  /** For the harness and status: live connections. */
  snapshot() {
    return [...this.all].filter(e => !e.dead).map(e => ({
      id: e.id, key: e.key, label: e.label, open: e.open, active: e.active, limit: e.limit,
      queued: e.queue.length, retired: e.retired, sftp: !!e.sftp, connected: !!e.client,
    }));
  }
}

module.exports = { ConnPool, fingerprint, PoolError, DEFAULTS };
