/**
 * "An agent wants to run a destructive command": the user's Run once / Block,
 * asked in a Termilab window (agent-service -> here -> renderer -> here).
 *
 *   main pushes  'agent:approval-prompt'  {requestId, client, host, tool, category, label, reason, command, timeoutMs}
 *   renderer     invoke('agent:approval-response', {requestId, approve})
 *   main pushes  'agent:approval-cancel'  {requestId, reason} when it gives up (timeout) so the modal closes
 *
 * Anything but an explicit approve from the window it was shown in is a
 * Block: no window, a failed send, a timeout (2 min), the window closing
 * with no other window to move to. One answer per request: approving runs
 * that one call, once; nothing is remembered.
 *
 * No electron here (the harness drives it with fake windows); bringing the
 * window to the front and the desktop notification come in as `present`.
 */
const crypto = require('crypto');

const APPROVAL_TIMEOUT_MS = 120 * 1000;

class ApprovalBroker {
  constructor() {
    this.router = null;          // window-registry: focused() / liveWindows() / sendTo()
    this.present = null;         // (entry, payload) => void: front + notification if unfocused
    this.timeoutMs = APPROVAL_TIMEOUT_MS;
    /** requestId -> { payload, resolve, timer, target } */
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

  /* The focused window, else the first live one; `except` skips a closing window */
  _pickWindow(except) {
    if (!this.router) return null;
    const f = this.router.focused && this.router.focused();
    if (f && f.wc !== except && this._alive(f.wc)) return f;
    const live = (this.router.liveWindows && this.router.liveWindows()) || [];
    return live.find(e => e.wc !== except && this._alive(e.wc)) || null;
  }

  _show(req, entry) {
    req.target = entry.wc;
    if (!this._send(entry.wc, 'agent:approval-prompt', req.payload)) return false;
    try { if (this.present) this.present(entry, req.payload); } catch (err) { console.error('[Approval] present failed:', err.message); }
    return true;
  }

  /**
   * Ask the user. Resolves { approved: boolean, reason: 'approved'|'blocked'|'timeout'|'no-window' }.
   * Never throws.
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
      const req = { payload, resolve, timer: null, target: null };
      const entry = this._pickWindow(null);
      if (!entry) { resolve({ approved: false, reason: 'no-window' }); return; }
      this._pending.set(requestId, req);
      /* Not unref'd: a question in flight keeps the process (and the agent's call) alive */
      req.timer = setTimeout(() => this._finish(requestId, false, 'timeout'), this.timeoutMs);
      if (!this._show(req, entry)) this._finish(requestId, false, 'no-window');
    });
  }

  /** The renderer's answer. Only the window that shows the prompt can answer it. */
  respond(requestId, approve, from) {
    const req = this._pending.get(requestId);
    if (!req) return false;
    if (from !== undefined && from !== null && req.target && from !== req.target) return false;
    this._finish(requestId, approve === true, approve === true ? 'approved' : 'blocked');
    return true;
  }

  _finish(requestId, approved, reason) {
    const req = this._pending.get(requestId);
    if (!req) return;
    this._pending.delete(requestId);
    clearTimeout(req.timer);
    if (reason !== 'approved' && reason !== 'blocked' && req.target) {
      this._send(req.target, 'agent:approval-cancel', { requestId, reason });
    }
    req.resolve({ approved, reason });
  }

  /** A window closed: its open prompts move to another window (fresh timeout), or are blocked. */
  rejectFor(wc) {
    for (const [id, req] of [...this._pending]) {
      if (req.target !== wc) continue;
      const next = this._pickWindow(wc);
      if (!next) { req.target = null; this._finish(id, false, 'no-window'); continue; }
      clearTimeout(req.timer);
      req.timer = setTimeout(() => this._finish(id, false, 'timeout'), this.timeoutMs);
      if (!this._show(req, next)) this._finish(id, false, 'no-window');
    }
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
