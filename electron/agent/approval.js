/**
 * "An agent wants to run a destructive command": the user's Run once / Block,
 * asked in a Termilab window (agent-service -> here -> renderer -> here).
 *
 *   main pushes  'agent:approval-prompt'  {requestId, client, host, tool, category, label, reason, command, timeoutMs}
 *   renderer     invoke('agent:approval-response', {requestId, approve})
 *   main pushes  'agent:approval-cancel'  {requestId, reason} when it gives up (timeout) so the modal closes,
 *                                         and {requestId, reason:'answered', by} to the clients that did not answer
 *
 * Where it is asked: ONE PC window (the focused one, else the first) and
 * EVERY web mirror client connected (virtual webContents, window-registry
 * listVirtual()): the owner may be at home on the browser. The first answer
 * wins; every other client gets 'agent:approval-cancel' {requestId, reason:
 * 'answered', by} so its modal closes, and a late answer is ignored. The
 * result says who answered (`by`: 'pc' or 'web:<login>') for the agent log.
 *
 * Anything but an explicit approve from a client it was shown in is a
 * Block: no client, failed sends, a timeout (2 min), every client closing
 * with no other window to move to. A browser that connects (or reloads) while
 * a request is open is shown it too (addClient); one that disconnects leaves
 * it (rejectFor), as a closing window does. One answer per request: approving runs
 * that one call, once; nothing is remembered.
 *
 * No electron here (the harness drives it with fake windows); bringing the
 * window to the front and the desktop notification come in as `present`.
 */
const crypto = require('crypto');
const { isVirtualWc } = require('../window-registry');

const APPROVAL_TIMEOUT_MS = 120 * 1000;

/** Who answered, for the agent log: 'pc' or 'web:<login>'. */
function clientLabel(wc) {
  if (!wc) return null;
  return isVirtualWc(wc) ? `web:${String(wc.login || 'unknown').slice(0, 100)}` : 'pc';
}

class ApprovalBroker {
  constructor() {
    this.router = null;          // window-registry: focused() / liveWindows() / listVirtual() / sendTo()
    this.present = null;         // (entry, payload) => void: front + notification if unfocused
    this.timeoutMs = APPROVAL_TIMEOUT_MS;
    /** requestId -> { payload, resolve, timer, targets: Set<wc>, pc: wc|null } */
    this._pending = new Map();
  }

  setRouter(router) { this.router = router; }

  _alive(wc) {
    try { return !!wc && !(wc.isDestroyed && wc.isDestroyed()); } catch (_) { return false; }
  }

  _send(wc, channel, payload) {
    if (!this.router || !this._alive(wc)) return false;
    try { return this.router.sendTo(wc, channel, payload) !== false; } catch (_) { return false; }
  }

  /* The focused PC window, else the first live one; `except` skips a closing window */
  _pickWindow(except) {
    if (!this.router) return null;
    const ok = (e) => e && e.wc !== except && !isVirtualWc(e.wc) && this._alive(e.wc);
    const f = this.router.focused && this.router.focused();
    if (ok(f)) return f;
    const live = (this.router.liveWindows && this.router.liveWindows()) || [];
    return live.find(ok) || null;
  }

  /* Every live web mirror client */
  _virtuals() {
    if (!this.router) return [];
    const list = typeof this.router.listVirtual === 'function'
      ? this.router.listVirtual()
      : ((this.router.liveWindows && this.router.liveWindows()) || []).filter(e => isVirtualWc(e.wc));
    return (list || []).filter(e => e && this._alive(e.wc));
  }

  /* One client more for `req`; the PC one is also brought forward. A client
     that arrives late is told the time left, not the full timeout. */
  _showTo(req, entry, isPc, late = false) {
    if (req.targets.has(entry.wc)) return true;
    const payload = late && req.deadline ? { ...req.payload, timeoutMs: Math.max(0, req.deadline - Date.now()) } : req.payload;
    if (!this._send(entry.wc, 'agent:approval-prompt', payload)) return false;
    req.targets.add(entry.wc);
    if (isPc) {
      req.pc = entry.wc;
      try { if (this.present) this.present(entry, req.payload); } catch (err) { console.error('[Approval] present failed:', err.message); }
    }
    return true;
  }

  _arm(requestId, req) {
    clearTimeout(req.timer);
    req.deadline = Date.now() + this.timeoutMs;
    /* Not unref'd: a question in flight keeps the process (and the agent's call) alive */
    req.timer = setTimeout(() => this._finish(requestId, false, 'timeout'), this.timeoutMs);
  }

  /**
   * Ask the user. Resolves { approved: boolean, reason: 'approved'|'blocked'|'timeout'|'no-window', by? }
   * (`by` only when someone answered: 'pc' or 'web:<login>'). Never throws.
   */
  ask(info) {
    const requestId = crypto.randomUUID();
    const payload = {
      requestId,
      client: String(info.client || '').slice(0, 80) || null,
      host: String(info.host || ''),
      tool: String(info.tool || ''),
      category: info.category,
      label: info.label,
      reason: info.reason,
      command: String(info.command || ''),
      cwd: typeof info.cwd === 'string' && info.cwd ? info.cwd : null,
      timeoutMs: this.timeoutMs,
    };
    return new Promise((resolve) => {
      const req = { payload, resolve, timer: null, targets: new Set(), pc: null };
      const pc = this._pickWindow(null);
      const web = this._virtuals();
      if (!pc && !web.length) { resolve({ approved: false, reason: 'no-window' }); return; }
      this._pending.set(requestId, req);
      this._arm(requestId, req);
      if (pc) this._showTo(req, pc, true);
      for (const e of web) this._showTo(req, e, false);
      if (!req.targets.size) this._finish(requestId, false, 'no-window');
    });
  }

  /**
   * An answer. Only a client it was shown in can answer it (`from` = the
   * sender's webContents); the first one wins, a late one returns false.
   */
  respond(requestId, approve, from) {
    const req = this._pending.get(requestId);
    if (!req) return false;
    if (from !== undefined && from !== null && req.targets.size && !req.targets.has(from)) return false;
    this._finish(requestId, approve === true, approve === true ? 'approved' : 'blocked', from || null);
    return true;
  }

  _finish(requestId, approved, reason, from = null) {
    const req = this._pending.get(requestId);
    if (!req) return;
    this._pending.delete(requestId);
    clearTimeout(req.timer);
    const answered = reason === 'approved' || reason === 'blocked';
    const by = answered ? clientLabel(from) : null;
    /* Every other client closes its modal (the one that answered already did).
       An answer with no sender came from the only client, if there is just one. */
    if (!(answered && !from && req.targets.size <= 1)) {
      const cancel = answered ? { requestId, reason: 'answered', by } : { requestId, reason };
      for (const wc of req.targets) {
        if (from && wc === from) continue;
        this._send(wc, 'agent:approval-cancel', cancel);
      }
    }
    req.resolve(by ? { approved, reason, by } : { approved, reason });
  }

  /**
   * A client closed. A browser just leaves the request; the PC window hands
   * it to another PC window (fresh timeout). With no client left: Block.
   */
  rejectFor(wc) {
    for (const [id, req] of [...this._pending]) {
      if (!req.targets.has(wc)) continue;
      req.targets.delete(wc);
      if (req.pc === wc) {
        req.pc = null;
        const next = this._pickWindow(wc);
        if (next && !req.targets.has(next.wc) && this._showTo(req, next, true)) this._arm(id, req);
      }
      if (!req.targets.size) this._finish(id, false, 'no-window');
    }
  }

  /**
   * A web mirror client connected (a reloaded page is a new one): every
   * request still open is shown there too, and its answer counts like any
   * other client's. Returns how many it got.
   */
  addClient(wc) {
    if (!this._alive(wc)) return 0;
    let n = 0;
    for (const req of this._pending.values()) {
      if (this._showTo(req, { wc }, false, true)) n++;
    }
    return n;
  }

  /** Quitting: everything still open is blocked. */
  rejectAll() {
    for (const id of [...this._pending.keys()]) this._finish(id, false, 'no-window');
  }

  pendingCount() { return this._pending.size; }
}

module.exports = new ApprovalBroker();
module.exports.ApprovalBroker = ApprovalBroker;
module.exports.APPROVAL_TIMEOUT_MS = APPROVAL_TIMEOUT_MS;
module.exports.clientLabel = clientLabel;
