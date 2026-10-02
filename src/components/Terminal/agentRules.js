/*
 * Which agent CLI is running in a terminal, and what it is doing, read from
 * the bottom rows of its screen (TerminalView scans them ~300 ms after output
 * settles, and every 1.5 s while it keeps flowing).
 *
 * Pure: no React, no xterm. `detectAgent(lines, prevId)` takes the last rows
 * as plain strings (xterm's translateToString(true)) and returns
 * {id, name, state} with state 'working' | 'blocked' | 'idle', or null when
 * no agent is recognised. Unknown means NO state: a rule only answers when
 * its own signature is on screen (or it was the agent here on the previous
 * scan and its idle prompt still is). A plain shell, vim, less… give null.
 *
 * 'done' is not read from the screen: the tracker below derives it (working
 * for >= 3 s, then the idle prompt), and an OSC/BEL notification
 * (TerminalView's attention()) sets it directly.
 *
 * Each pattern is a RegExp tested per line, or a function(lines) returning
 * the index of the line it matched (-1 for none). Order inside a rule does
 * not matter; between states: blocked (if it is BELOW the idle prompt, or
 * there is no idle prompt) > working > idle. "Below" because a permission
 * prompt replaces the input box in these TUIs, while old conversation text
 * quoting "Do you want to proceed?" sits above it.
 *
 * `verified`: rules written by running that CLI in a pty and reading its
 * screen (Claude Code 2.1.287, codex-cli 0.128.0, 2026-10-02). The others are
 * from their documented/known UI strings and have not been seen live.
 */

/* Rows read from the bottom of the screen. Claude's todo list can sit
   between its spinner and its input box, so a little more than 15. */
export const AGENT_SCAN_ROWS = 18;
/* A turn shorter than this that ends at the prompt is not announced */
export const DONE_MIN_WORK_MS = 3000;
/* Scans in a row with nothing recognised before the agent is gone (a
   redraw can leave one empty frame) */
const MISSES_TO_FORGET = 2;

const RULE = /^\s*[─━]{20,}\s*$/;

/* Claude Code's input box: a full-width rule, the prompt line (❯, or > in
   older versions), and another rule a line or a few below (multi-line input). */
function claudeInputBox(lines) {
  for (let i = lines.length - 2; i >= 1; i--) {
    if (!/^\s*[❯>](\s|$)/.test(lines[i]) || !RULE.test(lines[i - 1])) continue;
    for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) {
      if (RULE.test(lines[j])) return i;
    }
  }
  return -1;
}

export const AGENT_RULES = [
  {
    id: 'claude',
    name: 'Claude Code',
    verified: true,
    signature: [
      claudeInputBox,
      /\? for shortcuts/,
      /(⏵⏵|⏸) .*mode on/,
      /shift\+tab to cycle/,
      /· \/effort\s*$/,
      /Claude Code v\d+\.\d+/,
      /Esc to cancel · Tab to amend/,
      /Yes, I trust this folder/,
      /Claude Code'll be able to read/,
      /Do you want to make this edit to /,
      /^\s*❯\s*1\.\s+\S/,
      /Enter to confirm · Esc to cancel/,
      /No, and tell Claude what to do differently/,
    ],
    working: [
      /* "✻ Choreographing… (5s · ↓ 265 tokens · thinking)": a spinner glyph,
         a verb, an ellipsis. Done is "✻ Baked for 8s" (no ellipsis). */
      /^\s*[·✢✳✶✻✽*∗]\s+\S[^…]{0,40}…(\s|$)/u,
      /\(\s*esc to interrupt\b/,
    ],
    blocked: [
      /Do you want to (proceed|make this edit|create|allow|overwrite|delete|run)\b/,
      /^\s*❯\s*1\.\s+\S/,
      /Esc to cancel · Tab to amend/,
      /Yes, I trust this folder/,
      /Enter to confirm · Esc to cancel/,
    ],
    idle: [claudeInputBox],
  },
  {
    id: 'codex',
    name: 'Codex',
    verified: true,
    signature: [
      /* Footer: "gpt-5.5 default · /path" (model, reasoning effort) */
      /^\s+(gpt-[\w.-]+|o\d[\w-]*|codex-[\w.-]+)\s+(default|minimal|low|medium|high|xhigh)\b.* · /,
      /OpenAI Codex \(v\d/,
      /tokens used\s+\d+% context left/,                    // older footer, unverified
      /\(\s*(\d+h\s*)?(\d+m\s*)?\d+s\s*•\s*esc to interrupt\)/,
      /Press enter to confirm or esc to cancel/,
      /Would you like to (run the following command|make the following edits)\?/,
    ],
    working: [
      /* "• Working (42s • esc to interrupt)". Not "• Starting MCP servers / Booting MCP server
         (3/4) (0s • esc to interrupt)" at launch: that is no turn, and a
         slow start would end in a "finished" chime. */
      (lines) => {
        for (let i = lines.length - 1; i >= 0; i--) {
          if (/\(\s*(\d+h\s*)?(\d+m\s*)?\d+s\s*•\s*esc to interrupt\)/.test(lines[i]) && !/(Starting|Booting) MCP server/.test(lines[i])) return i;
        }
        return -1;
      },
    ],
    blocked: [
      /Would you like to (run the following command|make the following edits|apply)/,
      /Press enter to confirm or esc to cancel/,
      /^\s*›\s*1\.\s+Yes\b/,
      /Allow command\?/,
      /Do you trust the (contents|files) of this directory/,   // unverified (trust prompt)
    ],
    /* "› Use /skills…" (placeholder) or what is being typed; not "› 1. Yes" */
    idle: [/^›(\s(?!\s*\d+\.\s)|$)/],
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    verified: false,
    signature: [
      /Type your message or @path\/to\/file/,
      /no sandbox \(see \/docs\)/,
      /gemini-[\d.]+-(pro|flash)[\w.-]*.*context left/,
      /\(esc to cancel, \d+s\)/,
      /Waiting for user confirmation/,
    ],
    working: [/\(esc to cancel, (\d+m )?\d+s\)/],
    blocked: [
      /Allow execution of/,
      /Waiting for user confirmation/,
      /Apply this change\?/,
      /^\s*[●❯>]?\s*1\.\s+(Yes, allow once|Allow once)/,
    ],
    idle: [/^\s*[│|]\s*>\s/],
  },
  {
    id: 'opencode',
    name: 'opencode',
    verified: false,
    signature: [
      /\bopencode\s+v?\d+\.\d+\.\d+/,
      /ctrl\+p\s+commands/,
      /\benter\s+send\b/,
      /Permission required/,
    ],
    working: [/\besc\s+(to\s+)?interrupt\b/],
    blocked: [/Permission required/, /\b(Allow once|Allow always)\b/],
    idle: [/\benter\s+send\b/, /ctrl\+p\s+commands/],
  },
  {
    id: 'aider',
    name: 'Aider',
    verified: false,
    signature: [
      /^Aider v\d+\.\d+/,
      /^Main model: /,
      /^Repo-map: /,
      /^Tokens: .* sent, .* received/,
      /\(Y\)es\/\(N\)o/,
    ],
    working: [/Waiting for [\w./:-]+/],
    blocked: [/\(Y\)es\/\(N\)o.*\[(Yes|No)\]:\s*$/],
    /* "> ", "architect> ", "ask> ": only once Aider is known to be here */
    idle: [/^(\w+ )?(multi )?>\s?$/],
  },
];

const RULES_BY_ID = new Map(AGENT_RULES.map(r => [r.id, r]));

/** Lowest (closest to the bottom) line a pattern list matches, or -1 */
function lastMatch(patterns, lines) {
  let best = -1;
  for (const p of patterns) {
    if (typeof p === 'function') {
      const i = p(lines);
      if (i > best) best = i;
      continue;
    }
    for (let i = lines.length - 1; i > best; i--) {
      if (p.test(lines[i])) { best = i; break; }
    }
  }
  return best;
}

function classify(rule, lines, sticky) {
  const sig = lastMatch(rule.signature, lines);
  const idle = lastMatch(rule.idle, lines);
  const blocked = lastMatch(rule.blocked, lines);
  const working = lastMatch(rule.working, lines);
  /* Without its signature, only the agent that was here, and only by its own
     prompt or spinner: question text alone ("Do you want to proceed?") is
     what a shell prints too */
  if (sig < 0 && !(sticky && (idle >= 0 || working >= 0))) return null;
  let state = 'idle';
  if (blocked >= 0 && blocked > idle) state = 'blocked';
  else if (working >= 0) state = 'working';
  return { id: rule.id, name: rule.name, state };
}

/**
 * @param {string[]} lines  the bottom rows of the screen, top to bottom
 * @param {string|null} prevId  the agent recognised here on the last scan
 * @returns {{id, name, state}|null}
 */
export function detectAgent(lines, prevId = null) {
  if (!Array.isArray(lines) || !lines.length) return null;
  const clean = lines.map(l => (typeof l === 'string' ? l.replace(/\s+$/, '') : ''));
  /* The agent that was here gets the first look (and its weak idle prompt) */
  const prev = prevId ? RULES_BY_ID.get(prevId) : null;
  if (prev) {
    const r = classify(prev, clean, true);
    if (r) return r;
  }
  for (const rule of AGENT_RULES) {
    if (rule === prev) continue;
    const r = classify(rule, clean, false);
    if (r) return r;
  }
  return null;
}

/** The last `rows` lines that matter: blank rows under the last text (a
    screen that is not full yet, a TUI drawn at the top) are not counted. */
export function bottomRows(lines, rows = AGENT_SCAN_ROWS) {
  let end = lines.length;
  while (end > 0 && !/\S/.test(lines[end - 1] || '')) end--;
  return lines.slice(Math.max(0, end - rows), end);
}

/** The bottom rows of an xterm's active buffer (its screen), as plain strings */
export function screenTail(term, rows = AGENT_SCAN_ROWS) {
  const b = term && term.buffer && term.buffer.active;
  if (!b) return [];
  const all = [];
  for (let y = b.baseY; y < b.baseY + term.rows; y++) {
    const line = b.getLine(y);
    all.push(line ? line.translateToString(true) : '');
  }
  return bottomRows(all, rows);
}

/**
 * Per terminal: turns scans into the state that goes on the tab, and says
 * when to alert. `scan()` and `oscDone()` return {agent, changed, event}:
 * agent = {id, name, state, since} | null; event 'done' (working >= 3 s,
 * then the idle prompt, and the user did not just type: an Esc that
 * interrupts is not "finished") or 'blocked' (it just started waiting).
 */
export function createAgentTracker(initial = null) {
  /* A tab moved in from another window brings its last state (and since) */
  let cur = initial && initial.id ? { id: initial.id, name: initial.name, state: initial.state, since: initial.since } : null;
  let workStart = 0;
  let misses = 0;
  const set = (next) => { cur = next; return cur; };
  return {
    get: () => cur,
    scan(result, now = Date.now(), { typedRecently = false } = {}) {
      if (!result) {
        misses++;
        if (cur && misses >= MISSES_TO_FORGET) {
          set(null);
          workStart = 0;
          return { agent: null, changed: true, event: null };
        }
        return { agent: cur, changed: false, event: null };
      }
      misses = 0;
      if (!cur || cur.id !== result.id) {
        workStart = result.state === 'working' ? now : 0;
        set({ id: result.id, name: result.name, state: result.state, since: now });
        return { agent: cur, changed: true, event: result.state === 'blocked' ? 'blocked' : null };
      }
      const prev = cur.state;
      let next = result.state;
      let event = null;
      if (next === 'idle' && prev === 'done') next = 'done';
      else if (next === 'idle' && prev === 'working') {
        if (workStart && now - workStart >= DONE_MIN_WORK_MS && !typedRecently) { next = 'done'; event = 'done'; }
        workStart = 0;
      } else if (next === 'working' && prev !== 'working') {
        /* Approving a prompt resumes the same turn */
        if (!(prev === 'blocked' && workStart)) workStart = now;
      } else if (next === 'blocked' && prev !== 'blocked') {
        event = 'blocked';
      }
      if (next === 'idle' && prev === 'blocked') workStart = 0;
      if (next === prev) return { agent: cur, changed: false, event: null };
      set({ ...cur, state: next, since: now });
      return { agent: cur, changed: true, event };
    },
    /** A BEL/OSC notification said the turn ended */
    oscDone(now = Date.now()) {
      if (!cur || cur.state === 'done') return { agent: cur, changed: false, event: null };
      workStart = 0;
      set({ ...cur, state: 'done', since: now });
      return { agent: cur, changed: true, event: null };
    },
  };
}

/* ─── Shared by the tab, pane header and Agents panel ─── */

export const AGENT_STATE_LABEL = { working: 'working', blocked: 'needs input', done: 'done', idle: 'idle' };
/* Agents panel order: what needs the user first */
export const AGENT_STATE_ORDER = { blocked: 0, done: 1, working: 2, idle: 3 };

/** "12s", "2m", "1h 5m" since `since` */
export function agentElapsed(since, now = Date.now()) {
  const s = Math.max(0, Math.round((now - (Number.isFinite(since) ? since : now)) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/** "Claude Code · working for 2m" */
export function agentTooltip(agent, now = Date.now()) {
  if (!agent) return '';
  const label = AGENT_STATE_LABEL[agent.state] || agent.state;
  return `${agent.name} · ${label} for ${agentElapsed(agent.since, now)}`;
}

/** The most urgent agent among a tab's panes (blocked > working > done > idle), for its tab dot */
export function leadAgent(tabs) {
  const rank = { blocked: 0, working: 1, done: 2, idle: 3 };
  let best = null;
  for (const t of tabs || []) {
    const a = t && t.agent;
    if (!a) continue;
    if (!best || (rank[a.state] ?? 9) < (rank[best.state] ?? 9)) best = a;
  }
  return best;
}

/* An OSC notification text that is a request, not "finished" */
export const NEEDS_YOU_TEXT = /\b(needs your (permission|approval)|permission to use|approval (needed|required)|requires approval)\b/i;
