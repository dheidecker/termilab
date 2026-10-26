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
      /* At the start of the row: Codex 0.162 also prints "← for agents · ? for shortcuts" */
      /^\s*\? for shortcuts/,
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
      /Enter to select · ↑\/↓ to navigate/,
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
      /* AskUserQuestion (2.1.300): the cursor can be on any option */
      /Enter to select · ↑\/↓ to navigate/,
    ],
    idle: [claudeInputBox],
  },
  {
    id: 'codex',
    name: 'Codex',
    verified: true,
    signature: [
      /* Footer: "gpt-5.5 default · /path" (model, reasoning effort); 0.162
         capitalises it: "GPT-6.1-Sol default · /path" */
      /^\s+(gpt-[\w.-]+|o\d[\w-]*|codex-[\w.-]+)\s+(default|minimal|low|medium|high|xhigh)\b.* · /i,
      /OpenAI Codex \(v\d/,
      /tokens used\s+\d+% context left/,                    // older footer, unverified
      /\(\s*(\d+h\s*)?(\d+m\s*)?\d+s\s*•\s*esc to interrupt\)/,
      /Press enter to confirm or esc to cancel/,
      /Would you like to (run the following command|make the following edits)\?/,
      /^\s*enter confirm · esc skip\s*$/,                   // "Hooks need review" at launch (0.162)
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
      /* Any numbered menu with its cursor (0.162: "Hooks need review" at launch) */
      /^\s*›\s*\d+\.\s+\S/,
      /^\s*enter confirm · esc skip\s*$/,
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

/* ─── Agent to agent: may a message be typed here? ───
   detectAgent() answers "which agent is on screen", and a screen can lie: a
   Claude that exited leaves its ─❯─ box behind, `cat` of a text quoting its
   footer, an old Aider banner over a bash prompt. Typing into that bash
   would run the message as commands. So, to SEND (electron/agent/agent-talk.js
   via TerminalView), the xterm cursor itself must be in the agent's input
   field, on its prompt row:
     Claude Code  the "❯ " / "> " row, with a full-width rule right above it
                  and another a few rows below; under that rule only its
                  footer (indented rows: mode line, status line, hints)
     Codex        the "› " row (not a "› 1." menu row); under it only its
                  footer (indented rows), one of them Codex's own
   A cursor on a row that looks like a shell prompt, or below the box, is
   "no agent". Other agents (Aider, Gemini, opencode) have no verified input
   field yet: no messages to them. Works the same on the alternate screen
   (Codex and Claude Code ≥ 2.1.310 draw there). Seen live: Claude Code
   2.1.300 / 2.1.310 keep the cursor on the "❯" row while idle. */

const TALK_FOOTER_MAX = 12;
/* A shell prompt: "user@host:~/dir$ ", "[x@y d]# ", "% ", "PS C:\> "… */
const SHELL_PROMPT = /(^|\s)\S*[$#%]\s?$|^\S+@\S+.*[$#%>]\s?$|^PS [^>]*>\s?$/;
const MENU_ROW = /^\s*[❯›>]\s*\d{1,2}\.\s/u;
const CODEX_FOOTER = [
  ...AGENT_RULES.find(r => r.id === 'codex').signature,
  /\? for shortcuts/, /context left/, /⏎ send/,
];

function footerOk(rows, from, extra) {
  let n = 0;
  let mine = !extra;
  for (let y = from; y < rows.length; y++) {
    const l = rows[y];
    if (!/\S/.test(l)) continue;
    /* The agent's footer is indented; a row at column 0 is someone else's (a shell prompt) */
    if (/^\S/.test(l)) return false;
    if (++n > TALK_FOOTER_MAX) return false;
    if (extra && extra.some(p => p.test(l))) mine = true;
  }
  return mine;
}

/**
 * @param {string[]} rows  EVERY row of the screen (the active buffer's
 *   viewport), top to bottom: not trimmed, so row indexes match the cursor
 * @param {number} cursorY  the cursor's row in `rows` (buffer.cursorY)
 * @param {string|null} agentId  the agent detected here
 * @param {number} [cursorX]
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function talkInputAt(rows, cursorY, agentId, cursorX = null) {
  if (!Array.isArray(rows) || !Number.isInteger(cursorY) || cursorY < 0 || cursorY >= rows.length) {
    return { ok: false, reason: 'the cursor is not on the screen' };
  }
  const clean = rows.map(l => (typeof l === 'string' ? l.replace(/\s+$/, '') : ''));
  const row = clean[cursorY];
  if (MENU_ROW.test(row)) return { ok: false, reason: 'a menu is open' };
  if (agentId === 'claude') {
    const m = /^(\s*)[❯>](\s|$)/u.exec(row);
    if (!m) return { ok: false, reason: SHELL_PROMPT.test(row) ? 'the cursor is on a shell prompt' : 'the cursor is not in the input box' };
    if (Number.isInteger(cursorX) && cursorX <= m[1].length) return { ok: false, reason: 'the cursor is not in the input box' };
    if (cursorY < 1 || !RULE.test(clean[cursorY - 1])) return { ok: false, reason: 'the cursor is not in the input box' };
    let bottom = -1;
    for (let y = cursorY + 1; y < Math.min(clean.length, cursorY + 12); y++) {
      if (RULE.test(clean[y])) { bottom = y; break; }
      if (/^\s*[❯>›](\s|$)/u.test(clean[y])) break;
    }
    if (bottom < 0) return { ok: false, reason: 'the cursor is not in the input box' };
    if (!footerOk(clean, bottom + 1, null)) return { ok: false, reason: 'something other than the agent is below its input box' };
    return { ok: true };
  }
  if (agentId === 'codex') {
    if (!/^›(\s|$)/u.test(row)) return { ok: false, reason: SHELL_PROMPT.test(row) ? 'the cursor is on a shell prompt' : 'the cursor is not in the input field' };
    if (Number.isInteger(cursorX) && cursorX < 1) return { ok: false, reason: 'the cursor is not in the input field' };
    if (!footerOk(clean, cursorY + 1, CODEX_FOOTER)) return { ok: false, reason: 'something other than the agent is below its input field' };
    return { ok: true };
  }
  return { ok: false, reason: agentId ? 'messages only go to Claude Code or Codex (their input field is known)' : 'no agent CLI here' };
}

/** Every row of an xterm's screen (talkInputAt), with the cursor */
export function screenRows(term) {
  const b = term && term.buffer && term.buffer.active;
  if (!b) return { rows: [], cursorY: -1, cursorX: -1, alt: false };
  const rows = [];
  for (let y = b.baseY; y < b.baseY + term.rows; y++) {
    const line = b.getLine(y);
    rows.push(line ? line.translateToString(true) : '');
  }
  return { rows, cursorY: b.cursorY, cursorX: b.cursorX, alt: b.type === 'alternate' };
}

/* ─── Shared by the tab, pane header and Sessions dock ─── */

export const AGENT_STATE_LABEL = { working: 'working', blocked: 'needs input', done: 'done', idle: 'idle' };

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

/* ─── Quick answers: the choices of the prompt on screen ───
   parseChoices(lines, agentId, {cursorLine}) → [{label, keys, hint, cancel?, default?}]
   `keys` is exactly what to send to the session. [] = not sure: show nothing.

   Three shapes, read from the bottom rows (screenTail):
   1. A numbered menu with its cursor: "❯ 1. Yes / 2. … / 4. No" (Claude Code),
      "› 1. Yes, proceed (y) / … / 3. No, and tell Codex… (esc)" (Codex), with
      a footer right under it that says how to answer ("Esc to cancel · Tab to
      amend", "Press enter to confirm or esc to cancel", "enter confirm · esc
      skip"). No cursor or no footer = a numbered list in the conversation.
      Claude Code 2.1.299 and Codex 0.162.1 pick an option the moment its digit
      is pressed (seen live), so those get the digit; any other agent gets
      arrows from where the cursor is, then Enter.
   2. An unnumbered menu (Claude's trust prompt: "❯ No, exit / Yes, I trust
      this folder" + "Enter to confirm · Esc to cancel"). Digits do nothing
      there (seen live): arrows from the cursor + Enter, in one write (Ink
      takes "\e[B\r" in one chunk as Down then Enter, seen live).
   3. A shell-style question: "[Y/n]", "(y/n)", "[y/N]", "(yes/no/[fingerprint])?",
      Aider's "(Y)es/(N)o [Yes]:". Answered with the word and Enter (they read
      a line). Only when it is the last text on screen AND the row the cursor
      is on (`cursorLine`, when the caller knows it): `echo '[Y/n]'` followed
      by a shell prompt, or by a program still running, is no question.
   A footer that mentions Esc adds a Cancel (Esc) item, marked cancel:true.
   An option that answers with typed text carries `textKeys` (freeTextOption). */

const MENU_OPTION = /^(\s*)([❯›▶●>]\s*)?(\d{1,2})\.\s+(\S.*)$/u;
const MENU_FOOTER = /\b(esc to cancel|enter to confirm|press enter to confirm|enter confirm|esc skip)\b/i;
/* Digit = pick at once, verified live (Claude Code 2.1.299, Codex 0.162.1) */
const DIGIT_MENUS = new Set(['claude', 'codex']);
const DOWN = '\x1b[B';
const UP = '\x1b[A';
const MAX_CHOICES = 6;

/** Down/Up from the cursor's option to `to` */
function moveKeys(from, to) {
  const n = to - from;
  return n > 0 ? DOWN.repeat(n) : UP.repeat(-n);
}
/** Down/Up from the cursor's option to `to`, then Enter */
function arrowKeys(from, to) {
  return moveKeys(from, to) + '\r';
}

/** "Yes, proceed (y)" → "Yes, proceed"; an option that runs on is cut at " · " */
function cleanLabel(text) {
  return text.replace(/\s+\((?:[a-z]|esc|enter)\)\s*$/i, '').split(' · ')[0].trim();
}

function cancelItem(footer) {
  return /\besc\b/i.test(footer) ? [{ label: 'Cancel', keys: '\x1b', hint: 'Esc', cancel: true }] : [];
}

/* The footer among the last three rows, or -1 */
function footerIndex(lines) {
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 3); i--) {
    if (MENU_FOOTER.test(lines[i])) return i;
  }
  return -1;
}

function numberedMenu(lines, agentId) {
  const f = footerIndex(lines);
  if (f < 1) return [];
  /* Up from the footer: options (numbered down to 1) and the rows an option
     wraps onto (indented past its number) */
  const opts = [];
  let wrapIndent = Infinity;
  for (let i = f - 1; i >= 0; i--) {
    const l = lines[i];
    if (!/\S/.test(l)) {
      if (opts.length) return [];   // a gap inside the menu: not one menu
      continue;                     // blank rows between menu and footer
    }
    /* AskUserQuestion puts a rule above its last option ("Chat about this") */
    if (opts.length && RULE.test(l)) continue;
    const m = MENU_OPTION.exec(l);
    if (m) {
      opts.unshift({ n: Number(m[3]), cursor: !!m[2], text: m[4] });
      wrapIndent = m[1].length + (m[2] ? m[2].length : 0);
      if (Number(m[3]) === 1) break;
      continue;
    }
    const indent = l.match(/^\s*/)[0].length;
    if (opts.length && indent > wrapIndent) continue;
    return [];
  }
  if (opts.length < 2 || opts.length > MAX_CHOICES) return [];
  if (opts.some((o, k) => o.n !== k + 1)) return [];
  const cur = opts.findIndex(o => o.cursor);
  if (cur < 0 || opts.filter(o => o.cursor).length !== 1) return [];
  const digits = DIGIT_MENUS.has(agentId);
  const items = opts.map((o, k) => ({
    label: cleanLabel(o.text),
    keys: digits ? String(o.n) : arrowKeys(cur, k),
    hint: digits ? String(o.n) : null,
  }));
  if (items.some(c => !c.label)) return [];
  if (agentId === 'claude') freeTextOption(items, opts, cur, lines[f]);
  return [...items, ...cancelItem(lines[f])];
}

/* The option of a Claude Code menu that takes typed text, marked with
   `textKeys`: the keys that open its text field. The caller sends them, then
   the text (a paste), then Enter. All three seen live (Claude Code 2.1.300):
   - AskUserQuestion's "N. Type something.": its digit focuses the field.
     With the cursor already on it the field is open, and a digit would be
     typed INTO it: nothing to press.
   - A permission prompt's "No" when the footer says "Tab to amend": arrows
     to it, then Tab turns it into "No, and tell Claude what to do
     differently" with a field (a digit would pick "No" at once).
   - That field already open (cursor on it): nothing to press. */
const TYPE_SOMETHING = /^Type something\.?$/;
const AMENDED_NO = /^No, and tell Claude what to do differently$/;
function freeTextOption(items, opts, cur, footer) {
  let k = opts.findIndex(o => TYPE_SOMETHING.test(cleanLabel(o.text)));
  if (k >= 0) { items[k].textKeys = k === cur ? '' : String(opts[k].n); return; }
  if (AMENDED_NO.test(cleanLabel(opts[cur].text))) { items[cur].textKeys = ''; return; }
  if (!/\bTab to amend\b/i.test(footer)) return;
  k = opts.findIndex(o => /^No$/.test(cleanLabel(o.text)));
  if (k >= 0) items[k].textKeys = moveKeys(cur, k) + '\t';
}

function plainMenu(lines) {
  const f = footerIndex(lines);
  if (f < 1 || !/enter to confirm/i.test(lines[f])) return [];
  const opts = [];
  for (let i = f - 1; i >= 0; i--) {
    const l = lines[i];
    if (!/\S/.test(l)) { if (opts.length) break; continue; }
    const m = /^(\s*)(❯\s+)?(\S.*)$/u.exec(l);
    opts.unshift({ cursor: !!m[2], col: m[1].length + (m[2] ? m[2].length : 0), text: m[3] });
    if (opts.length > MAX_CHOICES) return [];
  }
  if (opts.length < 2) return [];
  const cur = opts.findIndex(o => o.cursor);
  if (cur < 0 || opts.filter(o => o.cursor).length !== 1) return [];
  /* Every label starts in the same column: a menu, not a paragraph */
  if (opts.some(o => o.col !== opts[cur].col)) return [];
  return [
    ...opts.map((o, k) => ({ label: cleanLabel(o.text), keys: arrowKeys(cur, k), hint: null })),
    ...cancelItem(lines[f]),
  ];
}

const YES_NO = /[[(]\s*(y(?:es)?)\s*\/\s*(n(?:o)?)\b[^[\]()]*(?:\[[^\]]*\][^[\]()]*)?[\])]\s*[:?]?\s*$/i;
const AIDER_YES_NO = /\(Y\)es\/\(N\)o\b.*\[(Yes|No)\]:\s*$/;

function yesNo(lines, cursorLine) {
  const last = lines[lines.length - 1];
  if (typeof cursorLine === 'string' && cursorLine.replace(/\s+$/, '') !== last) return [];
  const aider = AIDER_YES_NO.exec(last);
  if (aider) {
    return [
      { label: 'Yes', keys: 'y\r', hint: 'y', default: aider[1] === 'Yes' },
      { label: 'No', keys: 'n\r', hint: 'n', default: aider[1] === 'No' },
    ];
  }
  const m = YES_NO.exec(last);
  if (!m) return [];
  const word = m[1].length > 1;
  return [
    { label: 'Yes', keys: word ? 'yes\r' : 'y\r', hint: word ? null : 'y', default: !word && m[1] === 'Y' },
    { label: 'No', keys: word ? 'no\r' : 'n\r', hint: word ? null : 'n', default: !word && m[2] === 'N' },
  ];
}

/**
 * @param {string[]} lines  bottom rows of the screen (screenTail), top to bottom
 * @param {string|null} agentId  the agent detected here (detectAgent), or null
 * @param {{cursorLine?: string}} [opts]  the text of the cursor's row, if known
 * @returns {{label: string, keys: string, hint: string|null, cancel?: boolean, default?: boolean}[]}
 */
export function parseChoices(lines, agentId = null, { cursorLine } = {}) {
  if (!Array.isArray(lines) || !lines.length) return [];
  const rows = lines.map(l => (typeof l === 'string' ? l.replace(/\s+$/, '') : ''));
  while (rows.length && !/\S/.test(rows[rows.length - 1])) rows.pop();
  if (!rows.length) return [];
  const menu = numberedMenu(rows, agentId);
  if (menu.length) return menu;
  const plain = plainMenu(rows);
  if (plain.length) return plain;
  return yesNo(rows, cursorLine);
}

/** The text of the row the cursor is on (parseChoices' shell questions) */
export function cursorRowText(term) {
  const b = term && term.buffer && term.buffer.active;
  if (!b) return '';
  const line = b.getLine(b.baseY + b.cursorY);
  return line ? line.translateToString(true) : '';
}

/* ─── Claude Code's suggested next prompt (the "ghost text") ───
   After a reply Claude Code may print a suggested next prompt inside its
   empty input box, faint, and Tab accepts it. Seen live (2.1.300, pty +
   @xterm/headless): the row is "❯ " in normal intensity followed by the
   suggestion in SGR 2 (dim) with the DEFAULT foreground; what the user types
   is the same colour without dim, and the suggestion disappears as soon as
   the box has text. The startup placeholder ('Try "…"') is drawn exactly the
   same way but Tab does NOT take it, so it is not a suggestion. Only rule
   for Claude Code: no other agent has been seen doing this. */

/**
 * @param {{text: string, runs: [string, boolean|number][]}[]} rows  bottom rows
 *   of the screen (screenCells): each row's text and its runs of [text, dim]
 * @returns {string}  the suggestion, or '' (none, the box has text, placeholder)
 */
export function claudeSuggestion(rows) {
  if (!Array.isArray(rows) || !rows.length) return '';
  const texts = rows.map(r => (r && typeof r.text === 'string' ? r.text.replace(/\s+$/, '') : ''));
  const i = claudeInputBox(texts);
  if (i < 0 || !/^\s*❯(\s|$)/.test(texts[i])) return '';
  let end = i + 1;
  while (end < texts.length && !RULE.test(texts[end])) end++;
  const parts = [];
  for (let y = i; y < end; y++) {
    let prompt = y === i;
    for (const [t, dim] of rows[y].runs || []) {
      let txt = String(t || '');
      if (prompt) {
        /* The "❯" itself, and the space after it, are not dim */
        const m = /^\s*❯\s?/.exec(txt);
        if (!m) return '';
        txt = txt.slice(m[0].length);
        prompt = false;
      }
      if (!txt.trim()) continue;
      if (!dim) return '';             // the user's own text: no suggestion
      parts.push(txt.trim());
    }
  }
  const s = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (!s || /^Try ".*"$/.test(s)) return '';
  return s;
}

/** The bottom rows of an xterm's screen with their dim runs (claudeSuggestion) */
export function screenCells(term, rows = AGENT_SCAN_ROWS) {
  const b = term && term.buffer && term.buffer.active;
  if (!b) return [];
  const out = [];
  let cell = null;
  for (let y = b.baseY; y < b.baseY + term.rows; y++) {
    const line = b.getLine(y);
    if (!line) { out.push({ text: '', runs: [] }); continue; }
    const runs = [];
    for (let x = 0; x < line.length; x++) {
      cell = line.getCell(x, cell || undefined);
      if (!cell || cell.getWidth() === 0) continue;
      const dim = !!cell.isDim();
      const ch = cell.getChars() || ' ';
      const last = runs[runs.length - 1];
      if (last && last[1] === dim) last[0] += ch; else runs.push([ch, dim]);
    }
    out.push({ text: line.translateToString(true), runs });
  }
  let n = out.length;
  while (n > 0 && !/\S/.test(out[n - 1].text)) n--;
  return out.slice(Math.max(0, n - rows), n);
}
