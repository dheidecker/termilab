/**
 * Agent to agent: an AI agent asks Termilab to type a message into another
 * terminal where an agent CLI runs (Claude Code, Codex...), waits for that
 * agent's turn to end and gets its answer back. Plain messages, no threads.
 *
 *   list_sessions                       the open terminals (tabs + Background)
 *   send_to_session {session, message, wait, timeoutSec}
 *   wait_reply {session, timeoutSec}    the answer to the last message sent there
 *
 * Main never writes into the pty itself: it asks the window that OWNS the
 * terminal to type it (agent-talk:op), the same way the Composer does
 * (term.paste: bracketed paste when the program asked for it, then Enter).
 * That window watches for the end of the turn (BEL / OSC notification, or the
 * screen going from working to the idle prompt) and answers with the new text
 * of the screen (agent-talk:reply). For Claude Code in a LOCAL terminal the
 * answer is taken from its transcript instead (~/.claude/projects/…/*.jsonl,
 * read only), which is clean text; the screen is the fallback.
 *
 * Rules (the reasons are in docs/agents.md):
 *   - only a terminal where an agent CLI was recognised, never a plain shell
 *     (typing there would run commands past the destructive-command guard).
 *     Three layers: the row's agentId (the tab's tracker), the owner window's
 *     cursor rule (the xterm cursor must be ON the agent's input row,
 *     agentRules.talkInputAt) and, for local terminals, /proc: a live agent
 *     process in the tty's foreground group (proc-agent.js).
 *   - never the sender's own terminal (by TERMILAB_SESSION_ID, and by the
 *     caller's parent pid inside the target's process tree)
 *   - not while it waits for the user (permission prompt, question)
 *   - not when the user turned it off for that terminal (talkBlocked)
 *   - 8000 characters, 30 messages per hour per destination (reserved
 *     synchronously: parallel calls cannot overshoot)
 *   - the text is sanitised first (sanitizeTalkText: no C0 but \n, no ESC,
 *     DEL or C1), so it can never close a bracketed paste or press a key
 *   - one delivery in flight per destination; the others wait their turn in
 *     a queue, and the time queued counts against the caller's timeout
 *
 * Every delivery carries a short ref in its prefix ("· ref 7f3a9c"): the
 * transcript lookup matches that ref exactly, never just the text.
 *
 * Sender: local terminals export TERMILAB_SESSION_ID (local-shell-service);
 * termilab-cli / termilab-mcp pass it as `from`. It is INFORMATIVE: every
 * process belongs to the same user, any of them can set that variable.
 * Unknown = "an agent outside Termilab (unverified)". Every attempt goes to
 * agent-log (from, to, length, result).
 */
const crypto = require('crypto');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const LIMITS = {
  message: 8000,
  perHour: 30,
  reply: 32000,
  timeoutDefaultS: 600,
  timeoutMaxS: 3600,
  opMs: 10000,                // a window answering one op
  queueNoWaitS: 45,           // wait: false still waits its turn, this long at most
  deliveriesKept: 500,        // finished deliveries remembered (wait_reply)
  transcriptWaitMs: 2000,     // the transcript may land a moment after the bell
  transcriptFiles: 40,
  transcriptTail: 8 * 1024 * 1024,
  logPreview: 200,
};
const HOUR_MS = 60 * 60 * 1000;

/* Renderer agent states (agentRules.js) → what an agent is told */
const STATE = { working: 'working', blocked: 'waiting-permission', idle: 'idle', done: 'idle' };

class TalkError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (message, code = 'invalid') => { throw new TalkError(code, message); };

/** A stable short name for a terminal without an alias */
const shortId = (key) => `s${crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 5)}`;

const OUTSIDE = 'an agent outside Termilab (unverified)';

/**
 * What may be typed into another terminal: no C0 control but \n (\t becomes
 * spaces, \r\n and \r become \n), no ESC, no DEL, no C1 (U+0080–U+009F).
 * Without ESC nothing can close a bracketed paste (\e[201~) or send a key;
 * without \r / \x03 nothing submits or interrupts. The SAME function is in
 * src/components/Terminal/agentTalkText.js (the renderer repeats it): change
 * both together.
 */
function sanitizeTalkText(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '    ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '');
}

/** A short id for one delivery, written in its prefix ("· ref 7f3a9c") */
const newRef = () => crypto.randomBytes(3).toString('hex');

/** The text typed into the destination: always starts with "[" (never "!" or "/") */
function prefixed(senderName, message, ref) {
  const tail = ref ? ` · ref ${ref}` : '';
  const name = senderName ? sanitizeTalkText(senderName).replace(/["\]\n]/g, '').slice(0, 80) : '';
  return name
    ? `[Message from Termilab session "${name}"${tail}] ${message}`
    : `[Message from ${OUTSIDE}${tail}] ${message}`;
}

/** Last `max` characters (the answer is at the end) → {text, truncated} */
function capReply(text, max = LIMITS.reply) {
  const s = typeof text === 'string' ? text : '';
  return s.length > max ? { text: `…${s.slice(-max)}`, truncated: true } : { text: s, truncated: false };
}

/* ── Claude Code transcript (read only) ─────────────────────── */

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
};
const isToolResult = (content) => Array.isArray(content) && content.some(b => b && b.type === 'tool_result');
/* A prompt somebody typed (not a tool result, not meta, not a sub-agent's) */
const isPrompt = (e) => e && e.type === 'user' && !e.isMeta && !e.isSidechain && e.message
  && !isToolResult(e.message.content);

/**
 * The answer to the prompt that contains `needle`, in the transcript lines
 * given (oldest first): every assistant text block after the LAST such
 * prompt, up to the next prompt. → {reply, found} (reply '' = not answered yet)
 */
function replyFromTranscript(lines, needle) {
  const entries = [];
  for (const l of lines) {
    if (!l || l[0] !== '{') continue;
    try { entries.push(JSON.parse(l)); } catch (_) { /* a cut line */ }
  }
  const norm = (s) => String(s).replace(/\r\n?/g, '\n');
  const want = norm(needle);
  if (!want) return { found: false, reply: '' };
  let at = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isPrompt(entries[i]) && norm(textOf(entries[i].message.content)).includes(want)) { at = i; break; }
  }
  if (at < 0) return { found: false, reply: '' };
  const parts = [];
  for (let i = at + 1; i < entries.length; i++) {
    const e = entries[i];
    if (isPrompt(e)) break;
    if (e.type === 'assistant' && !e.isSidechain && e.message) {
      const t = textOf(e.message.content).trim();
      if (t) parts.push(t);
    }
  }
  return { found: true, reply: parts.join('\n\n') };
}

/** Search ~/.claude/projects for the conversation that got `needle` (a delivery's
    exact "· ref <id>]") after `since` */
async function transcriptReply({ home, needle, since }) {
  const root = path.join(home, '.claude', 'projects');
  let dirs;
  try { dirs = await fsp.readdir(root, { withFileTypes: true }); } catch (_) { return { found: false, reply: '', missing: true }; }
  const files = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let ents;
    try { ents = await fsp.readdir(path.join(root, d.name), { withFileTypes: true }); } catch (_) { continue; }
    for (const e of ents) if (e.isFile() && e.name.endsWith('.jsonl')) files.push(path.join(root, d.name, e.name));
  }
  const stats = [];
  await Promise.all(files.map(async (f) => {
    try { const st = await fsp.stat(f); if (st.mtimeMs >= since - 2000) stats.push({ f, mtimeMs: st.mtimeMs, size: st.size }); } catch (_) { /* gone */ }
  }));
  stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const s of stats.slice(0, LIMITS.transcriptFiles)) {
    let fh = null;
    let text = '';
    try {
      fh = await fsp.open(s.f, 'r');
      const len = Math.min(LIMITS.transcriptTail, s.size);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, s.size - len);
      text = buf.subarray(0, bytesRead).toString('utf-8');
    } catch (_) { continue; } finally { if (fh) await fh.close().catch(() => {}); }
    const r = replyFromTranscript(text.split('\n'), needle);
    if (r.found) return r;
  }
  return null;
}

/* ── The service ─────────────────────────────────────────────── */

class AgentTalk {
  constructor() {
    /*
     * Set by ipc-handlers (the harness sets fakes):
     *   rows()            live terminals of the PC windows (window-registry agentRows)
     *   background()      background-sessions records
     *   talkIdOf(sid)     TERMILAB_SESSION_ID of a local terminal's shell
     *   push(row, op)     send 'agent-talk:op' to the window owning row → its wc, or null
     *   home()            where ~/.claude is (read only)
     *   log               AgentLog
     */
    this.deps = null;
    this.limits = { ...LIMITS };
    /** id -> {wc, resolve, reject, timer}: ops waiting for their window */
    this.ops = new Map();
    /** deliveryId -> delivery */
    this.deliveries = new Map();
    /** tabId -> the last delivery to it; tabId\0from -> the last one from that sender (wait_reply) */
    this.last = new Map();
    this.lastBy = new Map();
    /** tabId -> [sentAt…] in the last hour (reserved before the write) */
    this.sent = new Map();
    /** tabId -> {active: delivery|null, waiting: [{dlv, resolve, timer}]}: one in flight per destination */
    this.queues = new Map();
  }

  configure(deps) { this.deps = deps; }

  _need() {
    if (!this.deps) fail('Talking to other sessions is not available in this Termilab.', 'unavailable');
    return this.deps;
  }

  /* ── Listing ── */

  /** Every terminal, as an agent sees it, plus internal fields (_row, _key…) */
  _list(from) {
    const d = this._need();
    const rows = (d.rows() || []).filter(r => r && r.tabId);
    const out = [];
    for (const r of rows) {
      const agent = r.agentId || null;
      const blocked = r.talkBlocked === true;
      const live = !!r.sessionId && r.connected !== false;
      const talkId = live && r.kind === 'local' && d.talkIdOf ? d.talkIdOf(r.sessionId) : null;
      const s = {
        session: r.alias || shortId(r.tabId),
        alias: r.alias || null,
        host: r.kind === 'local' ? 'local' : (r.host || 'SSH'),
        agent,
        state: agent ? (STATE[r.state] || 'unknown') : 'unknown',
        reachable: !!agent && !blocked && live,
        queued: this._queued(r.tabId),
      };
      if (!s.reachable) {
        s.note = !live ? 'not connected'
          : blocked ? 'the user does not let agents message this session'
            : 'no agent CLI detected (a plain shell or another program)';
      }
      out.push(Object.defineProperties(s, {
        _key: { value: r.tabId }, _row: { value: r }, _talkId: { value: talkId }, _blocked: { value: blocked },
      }));
    }
    for (const b of (d.background ? d.background() : []) || []) {
      if (!b || !b.keeperId) continue;
      const s = {
        session: b.alias || shortId(b.keeperId),
        alias: b.alias || null,
        host: b.kind === 'local' ? 'local' : (b.label || 'SSH'),
        agent: b.agent && b.agent.id ? b.agent.id : null,
        state: 'unknown',
        reachable: false,
        queued: 0,
        note: 'in the background (no window shows it): the user must reopen it in Termilab first',
      };
      out.push(Object.defineProperties(s, { _key: { value: `bg:${b.keeperId}` }, _background: { value: true } }));
    }
    if (from) for (const s of out) if (s._talkId && s._talkId === from) s.self = true;
    return out;
  }

  listSessions(p = {}) {
    const from = typeof p.from === 'string' ? p.from : null;
    return { sessions: this._list(from).map(s => ({ ...s })) };
  }

  /** By alias (case-insensitive) or short id. Ambiguous / missing: an error that lists the options. */
  _resolve(spec, list) {
    if (typeof spec !== 'string' || !spec.trim()) fail('Missing "session": an alias from list_sessions.');
    const want = spec.trim().toLowerCase();
    let hits = list.filter(s => s.alias && s.alias.toLowerCase() === want);
    if (!hits.length) hits = list.filter(s => s.session.toLowerCase() === want);
    if (hits.length === 1) return hits[0];
    const names = (l) => l.map(s => `"${s.session}" (${s.host}${s.agent ? `, ${s.agent}` : ''})`).join(', ');
    if (hits.length > 1) {
      fail(`"${spec}" matches ${hits.length} sessions: ${names(hits)}. Ask the user to give them different aliases (right-click in Sessions → Rename…).`, 'ambiguous');
    }
    const aliases = list.filter(s => s.alias).map(s => `"${s.alias}"`);
    fail(`No session named "${spec}". ${aliases.length ? `Aliases: ${[...new Set(aliases)].join(', ')}.` : 'No session has an alias yet.'} Call list_sessions for every session.`, 'not-found');
  }

  _sender(from, list) {
    if (typeof from !== 'string' || !from) return null;
    return list.find(s => s._talkId && s._talkId === from) || null;
  }

  /* ── Windows ── */

  _op(row, payload) {
    const d = this._need();
    const opId = crypto.randomBytes(9).toString('hex');
    const wc = d.push(row, { ...payload, opId, tabId: row.tabId, sessionId: row.sessionId || null });
    if (!wc) return Promise.reject(new TalkError('unreachable', 'The Termilab window that shows that session is not available.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ops.delete(opId);
        reject(new TalkError('timeout', 'The Termilab window that shows that session did not answer.'));
      }, this.limits.opMs);
      if (timer.unref) timer.unref();
      this.ops.set(opId, { wc, resolve, reject, timer });
    });
  }

  /** A window answered (agent-talk:reply): an op, or the end of a delivery's turn */
  reply(wc, id, payload) {
    if (typeof id !== 'string') return false;
    const op = this.ops.get(id);
    if (op) {
      if (op.wc !== wc) return false;
      this.ops.delete(id);
      clearTimeout(op.timer);
      const p = payload && typeof payload === 'object' ? payload : {};
      if (p.ok === false) op.reject(new TalkError(typeof p.code === 'string' ? p.code : 'refused', String(p.error || 'The session refused the message.').slice(0, 300)));
      else op.resolve(Object.defineProperty({ ...p }, '__wc', { value: op.wc }));
      return true;
    }
    const dlv = this.deliveries.get(id);
    if (!dlv || dlv.result) return false;
    /* Only the window that typed it (or watches it since the tab moved) ends its turn */
    if (!dlv.wc || dlv.wc !== wc) return false;
    this._finish(dlv, payload && typeof payload === 'object' ? payload : {}).catch(() => {});
    return true;
  }

  async _finish(dlv, p) {
    if (dlv.finishing || dlv.result) return;
    dlv.finishing = true;
    const blocked = p.event === 'blocked';
    let reply = typeof p.reply === 'string' ? p.reply : '';
    let source = 'screen';
    /* Claude Code on this computer: its transcript has the answer as clean text */
    if (!blocked && dlv.agent === 'claude' && dlv.kind === 'local') {
      const t = await this._transcript(dlv);
      if (t && t.reply) { reply = t.reply; source = 'transcript'; }
    }
    const cut = capReply(reply.trim(), this.limits.reply);
    dlv.result = {
      session: dlv.session,
      reply: cut.text,
      state: blocked ? 'waiting-permission' : 'idle',
      truncated: cut.truncated || p.truncated === true,
      source,
    };
    if (blocked) dlv.result.note = 'The session stopped to ask the user something (a permission prompt or a question). This is what it showed; the user has to answer it in Termilab.';
    this._release(dlv);
    for (const w of dlv.waiters) w();
    dlv.waiters = [];
  }

  async _transcript(dlv) {
    const d = this.deps;
    const home = d && d.home ? d.home() : os.homedir();
    /* The ref is unique per delivery: the same text sent to two sessions (or
       twice) never picks up another conversation's answer */
    const needle = `· ref ${dlv.ref}]`;
    const until = Date.now() + this.limits.transcriptWaitMs;
    for (;;) {
      let r = null;
      try { r = await transcriptReply({ home, needle, since: dlv.sentAt }); } catch (_) { r = null; }
      if (r && r.reply) return r;
      /* No ~/.claude/projects here at all: nothing will appear */
      if ((r && r.missing) || Date.now() >= until) return r;
      await new Promise(res => setTimeout(res, 250));
    }
  }

  /* ── Queue: one delivery in flight per destination ── */

  _queued(key) {
    const q = this.queues.get(key);
    return q ? q.waiting.length : 0;
  }

  /** Resolves when `dlv` may be typed; rejects (nothing typed) at `deadline` */
  _enqueue(dlv, deadline) {
    let q = this.queues.get(dlv.key);
    if (!q) { q = { active: null, waiting: [] }; this.queues.set(dlv.key, q); }
    if (!q.active) { q.active = dlv; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const entry = { dlv, resolve, timer: null };
      entry.timer = setTimeout(() => {
        const i = q.waiting.indexOf(entry);
        if (i >= 0) q.waiting.splice(i, 1);
        reject(new TalkError('timeout', `Session "${dlv.session}" was still busy with ${i >= 0 ? i + 1 : 'an'} earlier message(s) from agents when the time ran out. Nothing was sent; try again later.`));
      }, Math.max(0, deadline - Date.now()));
      if (entry.timer.unref) entry.timer.unref();
      q.waiting.push(entry);
    });
  }

  /** `dlv` is no longer in flight (its turn ended, it failed, or it ran out of time): the next one goes */
  _release(dlv) {
    if (dlv.released) return;
    dlv.released = true;
    clearTimeout(dlv.holdTimer);
    const q = this.queues.get(dlv.key);
    if (!q || q.active !== dlv) return;
    q.active = null;
    const next = q.waiting.shift();
    if (next) {
      clearTimeout(next.timer);
      q.active = next.dlv;
      next.resolve();
    } else {
      this.queues.delete(dlv.key);
    }
  }

  /* ── Tools ── */

  async send(p = {}, ctx = {}) {
    const t0 = Date.now();
    const startedAt = new Date(t0).toISOString();
    const message = p.message;
    const wait = p.wait !== false;
    let target = null;
    let senderName = null;
    const log = (ok, extra = {}) => {
      const d = this.deps;
      if (!d || !d.log) return null;
      const len = typeof message === 'string' ? message.length : 0;
      const clean = typeof message === 'string' ? sanitizeTalkText(message) : '';
      const preview = clean.length > this.limits.logPreview ? `${clean.slice(0, this.limits.logPreview)}…` : clean;
      return d.log.add({
        tool: 'send_to_session',
        host: target ? `session "${target.session}"` : sanitizeTalkText(String(p.session || '')).slice(0, 80),
        command: `from ${senderName ? `session "${senderName}"` : OUTSIDE} (${len} chars): ${preview}`,
        ok,
        ...extra,
        durationMs: Date.now() - t0,
        startedAt,
      });
    };
    let dlv = null;
    let reserved = null;
    const unreserve = () => {
      if (!reserved) return;
      const i = reserved.times.indexOf(reserved.at);
      if (i >= 0) reserved.times.splice(i, 1);
      reserved = null;
    };
    try {
      if (typeof message !== 'string' || !message.trim()) fail('Missing "message": the text to send.');
      if (message.length > this.limits.message) fail(`"message" is ${message.length} characters; the limit is ${this.limits.message}. Send a shorter message (put long content in a file and point to it).`);
      /* Before anything else: nothing that could act as a key reaches a terminal */
      const clean = sanitizeTalkText(message);
      if (!clean.trim()) fail('"message" has no text left once control characters are removed.');
      let secs = p.timeoutSec === undefined || p.timeoutSec === null ? this.limits.timeoutDefaultS : Number(p.timeoutSec);
      if (!Number.isFinite(secs) || secs < 0) fail('"timeoutSec" must be a number of seconds.');
      secs = Math.min(secs, this.limits.timeoutMaxS);
      /* wait: false only waits for its turn, and not long (the caller gives up at 60 s) */
      const deadline = t0 + 1000 * (wait ? secs : Math.min(secs, this.limits.queueNoWaitS));
      const list = this._list(p.from);
      const sender = this._sender(p.from, list);
      senderName = sender ? sender.session : null;
      target = this._resolve(p.session, list);
      const name = target.session;
      if (sender && sender._key === target._key) fail(`"${name}" is your own session: an agent cannot message itself.`, 'self');
      if (target._background) fail(`Session "${name}" is in the background (no window shows it). Ask the user to reopen it in Termilab (Sessions → Background) first.`, 'unreachable');
      /* Without (or with a false) TERMILAB_SESSION_ID: the caller's parent inside the target's process tree is itself */
      const callerPid = Number.isInteger(ctx.ppid) ? ctx.ppid : null;
      if (callerPid && target._row.kind === 'local' && target._row.sessionId != null && this.deps.pidInSession) {
        let inside = null;
        try { inside = await this.deps.pidInSession(target._row.sessionId, callerPid); } catch (_) { inside = null; }
        if (inside === true) fail(`"${name}" is your own session: an agent cannot message itself.`, 'self');
      }
      this._check(target);
      /* Reserve the slot now, synchronously with the check: parallel calls cannot overshoot */
      const now = Date.now();
      const times = (this.sent.get(target._key) || []).filter(x => now - x < HOUR_MS);
      this.sent.set(target._key, times);
      if (times.length >= this.limits.perHour) {
        fail(`Session "${name}" already got ${times.length} messages from agents in the last hour (the limit is ${this.limits.perHour}, against agents looping on each other). Nothing was sent; wait or ask the user.`, 'rate');
      }
      times.push(now);
      reserved = { times, at: now };
      const ref = this._newRef();
      const text = prefixed(senderName, clean, ref);
      const deliveryId = crypto.randomBytes(12).toString('hex');
      dlv = {
        id: deliveryId, ref, session: name, key: target._key, row: target._row, agent: target.agent,
        kind: target._row.kind, text, sentAt: now, waiters: [], result: null, status: 'queued', wc: null,
        released: false, holdTimer: null,
      };
      this.deliveries.set(deliveryId, dlv);
      this.last.set(target._key, dlv);
      this.lastBy.set(`${target._key}\0${p.from || ''}`, dlv);
      this._trim();
      const ahead = this._queued(target._key) + (this.queues.get(target._key)?.active ? 1 : 0);
      await this._enqueue(dlv, deadline);
      /* Its turn: the session may have changed while it waited */
      if (ahead) {
        const again = this._list(p.from).find(s => s._key === target._key);
        if (!again) fail(`Session "${name}" was closed while the message waited its turn. Nothing was sent.`, 'unreachable');
        target = again;
        dlv.row = target._row;
        this._check(target);
      }
      /* Local terminal: a live agent process in the foreground of its tty */
      if (target._row.kind === 'local' && this.deps.localAgent) {
        let fg = null;
        try { fg = await this.deps.localAgent(target._row.sessionId); } catch (_) { fg = null; }
        if (fg && fg.known && !fg.ok) {
          fail(`Session "${name}" runs no agent CLI now (its terminal's foreground program is ${fg.fg ? `"${fg.fg}"` : 'not an agent'}; an agent that exited can leave its box on screen). Nothing was sent.`, 'not-agent');
        }
      }
      const r = await this._op(target._row, { kind: 'send', deliveryId, text });
      dlv.status = 'sent';
      dlv.sentAt = Date.now();
      dlv.wc = r && r.__wc ? r.__wc : null;
      reserved = null;
      /* In flight until its turn ends, or until the caller's time is up */
      const holdMs = wait ? Math.max(0, deadline - Date.now()) : this.limits.timeoutDefaultS * 1000;
      dlv.holdTimer = setTimeout(() => this._release(dlv), holdMs);
      if (dlv.holdTimer.unref) dlv.holdTimer.unref();
      const queued = r && r.state === 'working';
      await log(true);
      const sent = { session: name, sent: true, queued: !!queued, ref };
      if (queued) sent.note = 'The session was busy with another turn: the agent queues the message and answers after that.';
      if (ahead) sent.waitedMs = dlv.sentAt - t0;
      if (!wait) return { ...sent, state: queued ? 'working' : 'sent' };
      const res = await this._wait(dlv, Math.max(0, deadline - Date.now()));
      return { ...sent, ...res };
    } catch (err) {
      unreserve();
      if (dlv && dlv.status !== 'sent') {
        this._release(dlv);
        this.deliveries.delete(dlv.id);
        if (this.last.get(dlv.key) === dlv) this.last.delete(dlv.key);
        for (const [k, v] of this.lastBy) if (v === dlv) this.lastBy.delete(k);
      }
      await log(false, { error: err.message });
      throw err;
    }
  }

  /** The rules that depend on the target's current row (also re-checked after waiting in the queue) */
  _check(target) {
    const name = target.session;
    if (!target.agent) fail(`Session "${name}" runs no agent CLI that Termilab recognises (it looks like a plain shell). Messages only go to an agent such as Claude Code or Codex: typed into a shell they would run as commands.`, 'not-agent');
    if (target._blocked) fail(`The user does not let agents message session "${name}" (Sessions → right-click → Let agents message this session).`, 'blocked');
    if (target._row.sessionId == null || target._row.connected === false) fail(`Session "${name}" is not connected.`, 'unreachable');
    if (target.state === 'waiting-permission') fail(`Session "${name}" is waiting for the user (a permission prompt or a question). Nothing was sent. Try again after the user answers it.`, 'busy');
  }

  _newRef() {
    for (;;) {
      const ref = newRef();
      let used = false;
      for (const d of this.deliveries.values()) if (d.ref === ref) { used = true; break; }
      if (!used) return ref;
    }
  }

  async waitReply(p = {}) {
    let secs = p.timeoutSec === undefined || p.timeoutSec === null ? this.limits.timeoutDefaultS : Number(p.timeoutSec);
    if (!Number.isFinite(secs) || secs < 0) fail('"timeoutSec" must be a number of seconds.');
    secs = Math.min(secs, this.limits.timeoutMaxS);
    const list = this._list(p.from);
    const target = this._resolve(p.session, list);
    const dlv = this.lastBy.get(`${target._key}\0${p.from || ''}`) || this.last.get(target._key);
    if (!dlv) fail(`Nothing was sent to session "${target.session}" since Termilab started: use send_to_session.`, 'not-found');
    if (!dlv.result && dlv.status === 'sent' && target._row && dlv.row !== target._row) {
      /* The tab moved to another window since: that one watches it now */
      dlv.row = target._row;
      try {
        const r = await this._op(target._row, { kind: 'watch', deliveryId: dlv.id, text: dlv.text });
        dlv.wc = r && r.__wc ? r.__wc : dlv.wc;
      } catch (_) { /* the old window may still answer */ }
    }
    return this._wait(dlv, secs * 1000);
  }

  async _wait(dlv, ms) {
    if (!dlv.result) {
      await new Promise((resolve) => {
        let timer = null;
        const waiter = () => { clearTimeout(timer); resolve(); };
        /* At its deadline a waiter leaves the list: nothing piles up per timed-out wait */
        timer = setTimeout(() => {
          const i = dlv.waiters.indexOf(waiter);
          if (i >= 0) dlv.waiters.splice(i, 1);
          resolve();
        }, ms);
        dlv.waiters.push(waiter);
      });
    }
    if (dlv.result) return { ...dlv.result, timedOut: false };
    if (dlv.status !== 'sent') {
      return {
        session: dlv.session, reply: '', state: 'queued', truncated: false, source: 'screen', timedOut: true,
        note: 'The message is still waiting for its turn behind other agents\' messages to that session. Call wait_reply with this session to keep waiting.',
      };
    }
    /* Not finished: what the screen shows so far, and the agent can wait_reply */
    let partial = {};
    const row = this._currentRow(dlv) || dlv.row;
    try { partial = await this._op(row, { kind: 'read', deliveryId: dlv.id, text: dlv.text }); } catch (_) { partial = {}; }
    const cut = capReply(String(partial.reply || '').trim(), this.limits.reply);
    return {
      session: dlv.session,
      reply: cut.text,
      state: STATE[partial.state] || 'working',
      truncated: cut.truncated || partial.truncated === true,
      source: 'screen',
      timedOut: true,
      note: 'The turn has not ended yet. Call wait_reply with this session to keep waiting.',
    };
  }

  _currentRow(dlv) {
    try {
      const rows = this.deps.rows() || [];
      return rows.find(r => r.tabId === dlv.row.tabId) || null;
    } catch (_) { return null; }
  }

  /* At most `deliveriesKept` deliveries; the oldest FINISHED ones go first
     (one still queued or in flight is never dropped) */
  _trim() {
    for (const [id, d] of this.deliveries) {
      if (this.deliveries.size <= this.limits.deliveriesKept) break;
      if (!d.result && !d.released) continue;
      this.deliveries.delete(id);
      if (this.last.get(d.key) === d) this.last.delete(d.key);
      for (const [k, v] of this.lastBy) if (v === d) this.lastBy.delete(k);
    }
  }

  /** A window went away: its ops fail now instead of at their timeout */
  dropWindow(wc) {
    for (const [id, op] of this.ops) {
      if (op.wc !== wc) continue;
      this.ops.delete(id);
      clearTimeout(op.timer);
      op.reject(new TalkError('unreachable', 'The Termilab window that showed that session closed.'));
    }
  }
}

const service = new AgentTalk();
module.exports = service;
module.exports.AgentTalk = AgentTalk;
module.exports.TalkError = TalkError;
module.exports.LIMITS = LIMITS;
module.exports.prefixed = prefixed;
module.exports.sanitizeTalkText = sanitizeTalkText;
module.exports.shortId = shortId;
module.exports.replyFromTranscript = replyFromTranscript;
module.exports.transcriptReply = transcriptReply;
