/**
 * Which window gets what (desktop multi-window). Pure: no `electron` require,
 * so the harness (scripts/check-main.js, section W) drives it with fake
 * windows, and the Android bundle carries it with its single shim window,
 * where every rule below collapses to "send it to the one window".
 *
 * Windows are keyed by their webContents object (an IPC event's `sender`).
 *
 *  - Per-session events (ssh:data/close/error/os-detected, local:data/
 *    close/error) go ONLY to the window that owns the session: the one whose
 *    renderer opened it (`claim`, done by ssh-service/local-shell-service
 *    before any listener is attached, so not even the first byte can go
 *    astray). A session with no owner (harness, a window already gone) falls
 *    back to the first window, i.e. what a single-window app did.
 *  - Global events (sync, updater, port forwards, transfer progress, edit
 *    events, store changes) go to every window (`broadcast*`).
 *
 * Moving a session to another window (a tab dragged out, "Move to window"):
 *
 *   source renderer  beginMove(ids)         main starts BUFFERING those ids and
 *                                           pushes 'window:move-mark' to it
 *   source renderer  waits for the mark, then flushes its xterm, serializes
 *                    it and hands it over
 *   target renderer  restores the buffer, then ready(moveId, id) per session
 *   main             once EVERY session of the tab is ready (all or nothing):
 *                    owner := target, flush each buffer to it, IN ORDER, and
 *                    from then on send there directly
 *   main             'window:move-done' to the source, which drops its tabs
 *                    without ending the sessions.
 *
 * Everything main emits for a session between beginMove and its commit lands
 * in the buffer. Everything before beginMove reached the source before the
 * MARK did: the mark goes out with webContents.send, the same ordered pipe as
 * the session's data. (Not the invoke reply: replies and pushes are NOT
 * ordered with each other; the first e2e lost exactly one chunk that way.)
 * So the source's serialization, taken after the mark, already holds it.
 * Nothing lost, nothing twice. A move that
 * does not finish in `moveTimeoutMs` (target crashed, closed) is aborted: the
 * buffer is flushed back to the source, which still has its tabs.
 */

const crypto = require('crypto');

const MOVE_TIMEOUT_MS = 15000;

const AGENT_STATES = new Set(['working', 'blocked', 'done', 'idle']);
const MAX_SESSION_ROWS = 200;
const text = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const hexColor = (v) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : null);
/* Sessions panel rows: every terminal (pane) of a window, in tab-bar order.
   The agent fields are there only when an agent CLI was recognised in it
   (state null otherwise). */
function cleanSessionRows(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const r of rows.slice(0, MAX_SESSION_ROWS)) {
    if (!r || typeof r !== 'object' || typeof r.tabId !== 'string' || !r.tabId) continue;
    const agent = AGENT_STATES.has(r.state);
    out.push({
      tabId: r.tabId.slice(0, 80),
      groupId: typeof r.groupId === 'string' && r.groupId ? r.groupId.slice(0, 80) : r.tabId.slice(0, 80),
      kind: r.kind === 'local' ? 'local' : 'ssh',
      connected: r.connected === true,
      muted: r.muted === true,
      agentId: agent ? text(r.agentId, 32) : null,
      name: agent ? (text(r.name, 40) || 'Agent') : null,
      state: agent ? r.state : null,
      since: agent && Number.isFinite(r.since) ? r.since : null,
      title: text(r.title, 120),
      /* The session alias ("logs") and the host label ("Mi Pc"), apart: the
         panel names the row after the alias and puts the host under it */
      alias: text(r.alias, 40) || null,
      host: text(r.host, 80),
      color: hexColor(r.color),
    });
  }
  return out;
}

class WindowRegistry {
  constructor() {
    /** webContents -> { id, number, win, wc, ready, adoptions: [] } */
    this._windows = new Map();
    /** sessionId -> webContents */
    this._owners = new Map();
    /** sessionId -> move (while buffering) */
    this._moving = new Map();
    /** moveId -> { id, from, to, sessionIds:Set, ready:Set, buffers: Map<sid, [channel, args][]>, adopted, timer } */
    this._moves = new Map();
    /** sessions released (ended) while being moved: dropped once flushed */
    this._releasedWhileMoving = new Set();
    /** sessions whose window closed (a connect still pending, a session
        being ended): their events and prompts go NOWHERE, never to another
        window. Cleared by release(). */
    this._closedOwner = new Set();
    this._seq = 0;
    this._factory = null;
    this.moveTimeoutMs = MOVE_TIMEOUT_MS;
    /** Sessions left with no live window (a move aborted after its source closed). */
    this.onOrphaned = null;

    /* Window-like objects for the services' setMainWindow(): they only call
       isDestroyed() and webContents.send(). */
    const self = this;
    this.broadcastSink = {
      isDestroyed: () => self.liveWindows().length === 0,
      webContents: {
        send: (channel, ...args) => self.broadcast(channel, ...args),
        isDestroyed: () => self.liveWindows().length === 0,
      },
    };
    /* Per-session events: the session id is the first argument
       (ssh:data, local:close…) or `.sessionId` of it (ssh:os-detected). */
    this.sessionSink = {
      isDestroyed: () => self.liveWindows().length === 0,
      webContents: {
        send: (channel, ...args) => {
          const first = args[0];
          const sid = typeof first === 'string' ? first : (first && typeof first.sessionId === 'string' ? first.sessionId : null);
          if (sid) self.sendToSession(sid, channel, ...args);
          else self.broadcast(channel, ...args);
        },
        isDestroyed: () => self.liveWindows().length === 0,
      },
    };
  }

  // ─── Windows ───────────────────────────────────────────

  _wc(x) {
    if (!x) return null;
    return x.webContents && typeof x.webContents.send === 'function' ? x.webContents : x;
  }

  _alive(wc) {
    if (!wc) return false;
    try {
      if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) return false;
    } catch (_) {
      return false;
    }
    const entry = this._windows.get(wc);
    if (entry && entry.win && entry.win !== wc && typeof entry.win.isDestroyed === 'function') {
      try { if (entry.win.isDestroyed()) return false; } catch (_) { return false; }
    }
    return true;
  }

  /** Register a BrowserWindow (or anything with .webContents.send). Idempotent. */
  addWindow(win) {
    const wc = this._wc(win);
    if (!wc) throw new Error('addWindow: no webContents');
    const existing = this._windows.get(wc);
    if (existing) return existing;
    const used = new Set([...this._windows.values()].map(e => e.number));
    let number = 1;
    while (used.has(number)) number++;
    const id = (win && typeof win.id === 'number') ? win.id : `w${++this._seq}`;
    const entry = { id, number, win: win === wc ? null : win, wc, ready: false, adoptions: [], unseen: 0, agents: [] };
    this._windows.set(wc, entry);
    return entry;
  }

  /**
   * A window closed. Returns the sessions it owned (the caller ends them).
   * Sessions it was handing to another window keep going (the move can still
   * commit); moves INTO it are aborted (back to their source).
   */
  removeWindow(winOrWc) {
    const wc = this._wc(winOrWc);
    const entry = this._windows.get(wc);
    if (!entry) return [];
    for (const move of [...this._moves.values()]) {
      if (move.to === wc) this.abort(move.id, 'target-closed');
    }
    this._windows.delete(wc);
    const owned = [];
    for (const [sid, owner] of this._owners) {
      if (owner !== wc) continue;
      if (this._moving.has(sid)) continue;   // on its way to a live window
      owned.push(sid);
    }
    for (const sid of owned) {
      this._owners.delete(sid);
      this._closedOwner.add(sid);
    }
    return owned;
  }

  entryOf(winOrWc) {
    return this._windows.get(this._wc(winOrWc)) || null;
  }

  byId(id) {
    for (const e of this._windows.values()) if (e.id === id || String(e.id) === String(id)) return e;
    return null;
  }

  liveWindows() {
    return [...this._windows.values()].filter(e => this._alive(e.wc));
  }

  primary() {
    return this.liveWindows()[0] || null;
  }

  /** The focused window, else the first one (a prompt with no session owner). */
  focused() {
    const live = this.liveWindows();
    for (const e of live) {
      try { if (e.win && typeof e.win.isFocused === 'function' && e.win.isFocused()) return e; } catch (_) { /* ignore */ }
    }
    return live[0] || null;
  }

  /** [{id, number, focused, self}] for a "Move to window" menu. */
  list(selfWc) {
    const focused = this.focused();
    return this.liveWindows().map(e => ({
      id: e.id,
      number: e.number,
      focused: !!focused && focused.wc === e.wc,
      self: e.wc === this._wc(selfWc),
      sessions: this.sessionsOf(e.wc).length,
    }));
  }

  /* "An agent finished" panes nobody has looked at yet, per window (its
     renderer reports them, window:attention). The dock/taskbar badge is the
     app-wide total; a closed window's go with it. */
  setUnseen(winOrWc, n) {
    const entry = this._windows.get(this._wc(winOrWc));
    if (!entry) return this.totalUnseen();
    entry.unseen = Number.isInteger(n) && n > 0 ? Math.min(n, 9999) : 0;
    return this.totalUnseen();
  }

  totalUnseen() {
    return this.liveWindows().reduce((sum, e) => sum + (e.unseen || 0), 0);
  }

  /* Sessions panel: each window reports its terminals, in tab-bar order
     (window:agents-report); every window gets the merged list, grouped by
     window number, its own rows marked `self`. Rows are cleaned here: they
     come from a renderer. A closed window's rows go with its entry. */
  setAgents(winOrWc, rows) {
    const entry = this._windows.get(this._wc(winOrWc));
    if (!entry) return false;
    entry.agents = cleanSessionRows(rows);
    return true;
  }

  /** {windows, rows:[{windowId, windowNumber, self, tabId, groupId, kind, connected, muted,
      agentId, name, state, since, title, alias, host, color}]} */
  agentRows(selfWc) {
    const self = this._wc(selfWc);
    const live = [...this.liveWindows()].sort((x, y) => (x.number || 0) - (y.number || 0));
    const rows = [];
    for (const e of live) {
      for (const r of e.agents || []) rows.push({ ...r, windowId: e.id, windowNumber: e.number, self: e.wc === self });
    }
    return { windows: live.length, rows };
  }

  setWindowFactory(fn) { this._factory = fn; }

  /** A new window ({x, y} optional). Throws where windows cannot be made (Android). */
  createWindow(opts = {}) {
    if (!this._factory) throw new Error('New windows are not available here');
    const win = this._factory(opts);
    return this.addWindow(win);
  }

  // ─── Sessions ──────────────────────────────────────────

  claim(sessionId, owner) {
    const wc = this._wc(owner);
    if (!sessionId || !wc) return;
    this._owners.set(sessionId, wc);
    this._closedOwner.delete(sessionId);
  }

  /**
   * May window `by` act on `sessionId` (write, resize, kill, sftp…)? Its
   * owner may; so may both ends of a move in flight (the source still drives
   * the paused session, the target's restored pane may type before the whole
   * tab commits). A session nobody owns (harness, mobile shim, already ended)
   * is left to the service. A session is borrowed (an SFTP pane reusing a
   * terminal's) only inside its owner's window: a tab with a borrowed
   * session does not move (windowMove.cannotMove), so owner = every user.
   */
  mayUse(sessionId, by) {
    if (!sessionId) return true;
    const owner = this._owners.get(sessionId);
    const move = this._moving.get(sessionId);
    if (!owner && !move) return !this._closedOwner.has(sessionId);
    const wc = this._wc(by);
    if (!wc) return false;
    if (owner === wc) return true;
    return !!move && (move.from === wc || move.to === wc);
  }

  /** The session ended. While a move buffers it, its last events still flush. */
  release(sessionId) {
    if (this._moving.has(sessionId)) {
      this._releasedWhileMoving.add(sessionId);
      return;
    }
    this._owners.delete(sessionId);
    this._closedOwner.delete(sessionId);
  }

  ownerOf(sessionId) {
    return this._owners.get(sessionId) || null;
  }

  sessionsOf(winOrWc) {
    const wc = this._wc(winOrWc);
    const out = [];
    for (const [sid, owner] of this._owners) if (owner === wc) out.push(sid);
    return out;
  }

  /** The window a prompt about `sessionId` should go to: its owner, else the focused one. */
  windowForSession(sessionId) {
    /* Its window closed: the prompt is nobody's (rejected), not the focused one's */
    if (sessionId && this._closedOwner.has(sessionId)) return null;
    const owner = sessionId ? this._owners.get(sessionId) : null;
    if (owner && this._alive(owner)) return owner;
    const f = this.focused();
    return f ? f.wc : null;
  }

  // ─── Sending ───────────────────────────────────────────

  sendTo(winOrWc, channel, ...args) {
    const wc = this._wc(winOrWc);
    if (!this._alive(wc)) return false;
    try {
      wc.send(channel, ...args);
      return true;
    } catch (err) {
      console.error(`[WindowRegistry] Failed to send ${channel}:`, err.message);
      return false;
    }
  }

  sendToSession(sessionId, channel, ...args) {
    const move = this._moving.get(sessionId);
    if (move) {
      move.buffers.get(sessionId).push([channel, args]);
      return true;
    }
    if (this._closedOwner.has(sessionId)) return false;
    const owner = this._owners.get(sessionId);
    if (owner && this._windows.has(owner)) return this.sendTo(owner, channel, ...args);
    /* Unowned (or its window is gone): what the single-window app did */
    const p = this.primary();
    return p ? this.sendTo(p.wc, channel, ...args) : false;
  }

  broadcast(channel, ...args) {
    for (const e of this.liveWindows()) this.sendTo(e.wc, channel, ...args);
  }

  broadcastExcept(except, channel, ...args) {
    const skip = this._wc(except);
    for (const e of this.liveWindows()) if (e.wc !== skip) this.sendTo(e.wc, channel, ...args);
  }

  // ─── Moving sessions between windows ───────────────────

  /**
   * Start buffering `sessionIds` (all of one tab, split panes included) that
   * `from` is about to hand over. Returns the move id.
   */
  beginMove(sessionIds, from) {
    const fromWc = this._wc(from);
    if (!this._windows.has(fromWc)) throw new Error('Unknown window');
    const ids = [...new Set((sessionIds || []).filter(s => typeof s === 'string' && s))];
    for (const sid of ids) {
      if (this._moving.has(sid)) throw new Error('That session is already being moved');
      const owner = this._owners.get(sid);
      if (owner && owner !== fromWc) throw new Error('That session belongs to another window');
    }
    const move = {
      id: crypto.randomUUID(),
      from: fromWc,
      to: null,
      sessionIds: new Set(ids),
      ready: new Set(),
      buffers: new Map(ids.map(s => [s, []])),
      adopted: false,
      timer: null,
    };
    for (const sid of ids) this._moving.set(sid, move);
    this._moves.set(move.id, move);
    move.timer = setTimeout(() => this.abort(move.id, 'timeout'), this.moveTimeoutMs);
    /* Behind every event already sent for these sessions, on the same pipe */
    this.sendTo(fromWc, 'window:move-mark', { moveId: move.id });
    return move.id;
  }

  getMove(moveId) {
    return this._moves.get(moveId) || null;
  }

  /** Where it goes. The payload reaches the target as 'window:adopt'. */
  setTarget(moveId, to, adoption) {
    const move = this._moves.get(moveId);
    if (!move) throw new Error('That move is no longer in progress');
    const toWc = this._wc(to);
    if (!this._windows.has(toWc)) throw new Error('Unknown window');
    if (toWc === move.from) throw new Error('The tab is already in that window');
    move.to = toWc;
    const entry = this._windows.get(toWc);
    const payload = { ...(adoption || {}), moveId };
    if (entry.ready) this.sendTo(toWc, 'window:adopt', payload);
    else entry.adoptions.push(payload);
  }

  /** The target renderer is listening: what was queued for it before it loaded. */
  takeAdoptions(winOrWc) {
    const entry = this._windows.get(this._wc(winOrWc));
    if (!entry) return [];
    entry.ready = true;
    /* Only moves still in flight (an aborted one's tabs live in the source) */
    const out = entry.adoptions.filter(a => this._moves.has(a.moveId));
    entry.adoptions = [];
    return out;
  }

  /** The target dispatched the adoption (its tabs exist). */
  adopted(moveId, by) {
    const move = this._moves.get(moveId);
    if (!move || move.to !== this._wc(by)) return false;
    move.adopted = true;
    this._maybeDone(move);
    return true;
  }

  /**
   * The target restored `sessionId`'s screen and listens for it. A tab moves
   * ALL OR NOTHING: nothing changes owner until every pane of it is ready
   * (and the tab adopted); then the target owns them all and gets what was
   * buffered, in order, before anything new. An abort before that leaves
   * every pane with the source: no split tab half here, half there.
   */
  commit(moveId, sessionId, by) {
    const move = this._moves.get(moveId);
    if (!move) return false;
    if (by && move.to !== this._wc(by)) return false;
    if (!move.sessionIds.has(sessionId) || move.ready.has(sessionId)) return false;
    move.ready.add(sessionId);
    this._maybeDone(move);
    return true;
  }

  /** Back to the source, buffer included. Idempotent. */
  abort(moveId, reason = 'aborted') {
    const move = this._moves.get(moveId);
    if (!move) return false;
    clearTimeout(move.timer);
    this._moves.delete(moveId);
    /* Not delivered yet (target still loading): it must never adopt it later */
    const target = move.to ? this._windows.get(move.to) : null;
    if (target) target.adoptions = target.adoptions.filter(a => a.moveId !== moveId);
    /* Not done = nothing was handed over (commit is all-or-nothing) */
    const back = [...move.sessionIds];
    const orphans = [];
    const sourceAlive = this._windows.has(move.from) && this._alive(move.from);
    for (const sid of back) {
      if (sourceAlive) this._settle(move, sid, move.from);
      else {
        this._moving.delete(sid);
        this._owners.delete(sid);
        if (!this._releasedWhileMoving.delete(sid)) orphans.push(sid);
      }
    }
    const info = { moveId, reason, sessionIds: back };
    if (sourceAlive) this.sendTo(move.from, 'window:move-aborted', info);
    if (move.to) this.sendTo(move.to, 'window:move-aborted', info);
    if (orphans.length && typeof this.onOrphaned === 'function') {
      try { this.onOrphaned(orphans); } catch (_) { /* caller's problem */ }
    }
    return true;
  }

  _settle(move, sid, wc) {
    const buffered = move.buffers.get(sid) || [];
    move.buffers.delete(sid);
    this._moving.delete(sid);
    this._owners.set(sid, wc);
    for (const [channel, args] of buffered) this.sendTo(wc, channel, ...args);
    if (this._releasedWhileMoving.delete(sid)) this._owners.delete(sid);
  }

  _maybeDone(move) {
    if (!move.adopted || move.ready.size !== move.sessionIds.size) return;
    clearTimeout(move.timer);
    this._moves.delete(move.id);
    for (const sid of move.sessionIds) this._settle(move, sid, move.to);
    this.sendTo(move.from, 'window:move-done', { moveId: move.id, sessionIds: [...move.sessionIds] });
  }
}

module.exports = new WindowRegistry();
module.exports.WindowRegistry = WindowRegistry;
module.exports.MOVE_TIMEOUT_MS = MOVE_TIMEOUT_MS;
