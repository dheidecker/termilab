/*
 * Agent to agent (electron/agent/agent-talk.js): what an agent CLI answered to
 * a message Termilab typed into it, read from the terminal's screen. Used for
 * every agent except Claude Code in a local terminal, whose transcript main
 * reads instead (clean text).
 *
 * Pure: no React, no xterm. `lines` are the buffer's logical lines (wrapped
 * rows joined) from a few lines above where the cursor was when the message
 * was typed, or the whole buffer when that place is gone (a TUI that cleared
 * the screen).
 *
 *   1. find the echo of the message: the first line near the cursor's (else
 *      the LAST line) that has its first words,
 *      and the line where its last characters end (spaces ignored, so a TUI
 *      that re-wraps the text still matches);
 *   2. take what comes after it;
 *   3. drop the agent's input box at the bottom (its idle prompt, from
 *      agentRules.js, and everything under it);
 *   4. cleanReply(): drop what is left of the echo (re-wrapped, or only its
 *      end when the top scrolled off), the agent's interface (spinners, the
 *      "✻ Sautéed for 15s · done 13:16" line, tool summaries and output,
 *      update notices) and keep the answer's "● " / "• " paragraphs, joined.
 *
 * Limits: an answer longer than the scrollback, or a TUI that redraws in
 * place (full-screen mode, the alternate screen), leaves only what is still
 * in the buffer; a collapsed paste ("[Pasted text #1 +12 lines]") is found by
 * that placeholder instead.
 */
import { AGENT_RULES } from './agentRules';

export const TALK_REPLY_MAX = 64000;

/**
 * What may be typed into a terminal (defence in depth: main already did it):
 * no C0 control but \n (\t becomes spaces, \r\n and \r become \n), no ESC,
 * no DEL, no C1. A COPY of sanitizeTalkText in electron/agent/agent-talk.js
 * (main is CommonJS, this is ESM): change both together.
 */
export function sanitizeTalkText(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '    ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '');
}

/**
 * The exact text to type: sanitised, and on ONE line unless the program
 * turned bracketed paste on (mode 2004): without it every \n would be an
 * Enter, and the next line would be a command of its own.
 */
export function talkPasteText(text, bracketed) {
  const t = sanitizeTalkText(text);
  return bracketed ? t : t.replace(/\n+/g, ' ');
}

const RULE = /^\s*[─━]{20,}\s*$/;
/* "✻ Baked for 8s", "✻ Sautéed for 15s · done 13:16", "✻ Worked for 1m 3s",
   a spinner "✢ Thinking… (esc to interrupt)", Codex's "• Working (3s • esc to
   interrupt)" and its "─ Worked for 12s ────" separator */
const STATUS = [
  /^\s*[·✢✳✶✻✽*∗]\s+\S[^…]{0,40}\bfor\s+(\d+h\s*)?(\d+m\s*)?\d+s\s*$/u,
  /^[·✢✳✶✻✽∗]\s+\S[^…]{0,40}\bfor\s+(\d+h\s*)?(\d+m\s*)?\d+s\s*(·.*)?$/u,
  /^\s*[·✢✳✶✻✽*∗]\s+\S[^…]{0,40}…/u,
  /\(\s*(\d+h\s*)?(\d+m\s*)?\d+s\s*•\s*esc to interrupt\)/,
  /\besc to interrupt\b/,
  /^\s*─+\s*Worked for\s+(\d+h\s*)?(\d+m\s*)?\d+s\s*─*\s*$/,
];

/* The agent's interface around its answer (never the answer itself):
   tool summaries ("Ran 1 shell command", "Read 2 files, ran 1 shell command"),
   "(ctrl+o to expand)" hints, update notices ("✔ Update installed · Restart
   to update") */
const TOOL_SUMMARY = /^(?:Ran|Read|Wrote|Edited|Searched|Listed|Fetched|Updated|Created|Called|Found|Loaded|Deleted|Viewed|Explored)\b[^.!?]{0,80}?\b\d+\s+(?:shell\s+)?(?:commands?|files?|patterns?|director(?:y|ies)|tools?|times?|lines?|urls?|pages?|results?|agents?|tasks?|searches|edits?)\b[^.!?]*$/i;
const UI_LINE = [
  (t) => TOOL_SUMMARY.test(t.replace(/^\s*(?:[●⏺•]\s+)?/u, '')),
  (t) => /\(ctrl\+o to expand\)\s*$/.test(t),
  (t) => /^\s*(?:[✔✓✗✘⚠!]\s*)?(?:Update installed|Auto-update failed|Update available)\b/u.test(t),
  (t) => /\bRestart to update\b/.test(t),
  (t) => RULE.test(t),
  (t) => STATUS.some(p => p.test(t)),
];
const isUi = (t) => UI_LINE.some(f => f(t));

/* Where an agent's answer is: a paragraph that starts at column 0 with its
   marker, and its continuation indented under it */
const ASSIST = { claude: /^[●⏺] (.*)$/u, codex: /^• (.*)$/u };
/* Tool output under a tool call: Claude "  ⎿  …", Codex "  └ …" / "  │ …" */
const TOOL_OUT = /^\s*[⎿└│]/u;
/* Codex tool calls that may have no "└" under them */
const CODEX_TOOL = /^(?:Explored|Exploring|Updated Plan|(?:Edited|Added)\s.*\(\+\d+ -\d+\)|Deleted \S+$)/;
/* A row of a list or a table: its own line, never joined to the one above */
const LIST_ITEM = /^(?:[-*•+]|\d{1,3}[.)])\s+/u;
const TABLE_ROW = /^[│┃|├┌└╭╰]/u;

/* How far above the cursor's line a TUI may start redrawing (status, rule) */
const ECHO_ABOVE = 8;

const compact = (s) => String(s).replace(/\s+/g, '');

function lastMatch(patterns, lines) {
  let best = -1;
  for (const p of patterns || []) {
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

/**
 * Index of the last line of the echoed message, or -1. `near`: the index of
 * the line the cursor was on when it was typed (null = unknown). The echo is
 * the first match from a few lines above it (a TUI redraws its input area
 * from its top), so an answer that quotes the message is not taken for it;
 * unknown: the last match.
 */
export function echoEnd(lines, text, near = null) {
  const msg = String(text || '').replace(/\r\n?/g, '\n');
  const first = msg.split('\n')[0];
  /* "[Message from Termilab session "x" · ref 7f3a9c] ping": its head up to
     the delivery's ref (unique), spaces ignored */
  const c0 = compact(first);
  const refAt = /·ref[0-9a-f]{4,}\]/.exec(c0);
  const head = refAt ? c0.slice(0, refAt.index + refAt[0].length) : c0.slice(0, 40);
  const nonEmpty = msg.split('\n').filter(l => l.trim());
  const tail = compact(nonEmpty[nonEmpty.length - 1] || '').slice(-24);
  if (!head) return -1;
  /* The head itself may be wrapped: a line that holds its first 16 chars */
  const isHead = (i) => { const c = compact(lines[i]); return c.includes(head) || (head.length > 16 && c.includes(head.slice(0, 16))); };
  let start = -1;
  if (Number.isInteger(near)) {
    for (let i = Math.max(0, near - ECHO_ABOVE); i < lines.length; i++) if (isHead(i)) { start = i; break; }
  }
  if (start < 0) {
    for (let i = lines.length - 1; i >= 0; i--) if (isHead(i)) { start = i; break; }
  }
  if (start < 0) {
    /* A collapsed paste in the input box */
    for (let i = lines.length - 1; i >= 0; i--) if (/\[Pasted text #\d+/.test(lines[i])) return i;
    return -1;
  }
  let acc = '';
  for (let j = start; j < Math.min(lines.length, start + 400); j++) {
    acc += compact(lines[j]);
    if (!tail || acc.includes(tail)) return j;
  }
  return start;
}

const indentOf = (l) => /^\s*/.exec(l)[0].length;
/* The prompt mark an agent prints before the echo of what was typed */
const PROMPT_MARK = /^\s*[>❯›]\s?/u;

/**
 * Indexes (in `lines`, among those `allowed`) that are the echo of `text`, or
 * a piece of it: a run of lines whose text, spaces and line breaks ignored,
 * is part of the message (so a re-wrapped echo, or its last part when the
 * top of it scrolled off, still matches). At least 12 characters, or the
 * whole message, so a short line that happens to be in it stays.
 */
function echoLines(lines, text, allowed) {
  const msg = compact(text);
  const drop = new Set();
  if (!msg) return drop;
  const min = Math.min(12, msg.length);
  for (let i = 0; i < lines.length; i++) {
    if (!allowed(i) || !lines[i].trim()) continue;
    for (const first of [compact(lines[i]), compact(lines[i].replace(PROMPT_MARK, ''))]) {
      if (!first || !msg.includes(first)) continue;
      let acc = first;
      let last = i;
      for (let j = i + 1; j < lines.length && allowed(j); j++) {
        const c = compact(lines[j]);
        if (!c) continue;
        if (!msg.includes(acc + c)) break;
        acc += c;
        last = j;
      }
      if (acc.length >= min) {
        for (let k = i; k <= last; k++) drop.add(k);
        i = last;
        break;
      }
    }
  }
  return drop;
}

/** One answer paragraph group → text: wrapped lines joined, list and table rows kept apart */
function joinBlock(rows) {
  const out = [];
  let open = null;   // {i: index in out, indent: where its continuation starts}
  for (const r of rows) {
    if (!r.text.trim()) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      open = null;
      continue;
    }
    const ind = r.indent;
    const t = r.text.trim();
    const item = LIST_ITEM.exec(t);
    if (item || TABLE_ROW.test(t)) {
      out.push(`${' '.repeat(ind)}${t}`);
      open = item ? { i: out.length - 1, indent: ind + item[0].length, list: true } : null;
      continue;
    }
    if (open && (open.list ? ind >= open.indent : ind === open.indent)) {
      out[open.i] += ` ${t}`;
      continue;
    }
    out.push(`${' '.repeat(ind)}${t}`);
    open = { i: out.length - 1, indent: ind, list: false };
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

/**
 * What an agent answered, from the screen lines that follow the message
 * (TerminalView, through extractReply): pure, no xterm.
 *   - drops the echo of the message, whole or in pieces, re-wrapped or not;
 *   - drops the agent's interface: spinners and "✻ Sautéed for 15s · done
 *     13:16", tool summaries ("Ran 1 shell command"), tool calls and their
 *     "⎿" / "└" output, update notices, rules;
 *   - for Claude Code and Codex keeps only the answer: each "● " / "• "
 *     paragraph without its marker, its indented continuation joined to it
 *     (list items and table rows on their own lines), groups separated by a
 *     blank line. Without any such paragraph (an answer not started yet,
 *     another agent): the remaining lines as they are.
 * @param {string[]} lines
 * @param {{text?: string, agentId?: string|null}} opts  text = what was typed
 * @returns {string}
 */
export function cleanReply(lines, { text = '', agentId = null } = {}) {
  const all = (Array.isArray(lines) ? lines : []).map(l => (typeof l === 'string' ? l.replace(/\s+$/, '') : ''));
  const marker = ASSIST[agentId] || null;
  /* Each line: 'assist' (an answer paragraph's first line), 'tool' (a tool
     call, its output), 'cont' (indented under the last of those) or 'other' */
  const kind = new Array(all.length).fill('other');
  if (marker) {
    let cur = null;
    for (let i = 0; i < all.length; i++) {
      const l = all[i];
      const m = marker.exec(l);
      if (m) {
        let next = i + 1;
        while (next < all.length && !all[next].trim()) next++;
        const tool = (next < all.length && TOOL_OUT.test(all[next]))
          || isUi(l) || (agentId === 'codex' && CODEX_TOOL.test(m[1]));
        cur = tool ? 'tool' : 'assist';
        kind[i] = cur;
        continue;
      }
      if (cur && (!l.trim() || /^\s/.test(l))) { kind[i] = cur === 'tool' ? 'tool' : 'cont'; continue; }
      cur = null;
    }
  }
  const echo = echoLines(all, text, (i) => kind[i] === 'other');
  const keep = (i) => !echo.has(i) && kind[i] !== 'tool' && !isUi(all[i]) && !(kind[i] === 'other' && TOOL_OUT.test(all[i]));
  if (marker && kind.includes('assist')) {
    const groups = [];
    let rows = null;
    for (let i = 0; i < all.length; i++) {
      if (kind[i] === 'assist') {
        rows = [{ indent: 0, text: marker.exec(all[i])[1] }];
        groups.push(rows);
      } else if (kind[i] === 'cont' && rows) {
        if (!keep(i)) continue;
        /* Under "● " the text starts at column 2 */
        rows.push({ indent: Math.max(0, indentOf(all[i]) - 2), text: all[i] });
      } else if (kind[i] !== 'cont') {
        rows = kind[i] === 'tool' ? rows : null;
      }
    }
    return groups.map(joinBlock).filter(g => g.length).map(g => g.join('\n')).join('\n\n');
  }
  const out = [];
  for (let i = 0; i < all.length; i++) {
    if (!keep(i)) continue;
    const l = all[i];
    if (!l.trim() && (!out.length || !out[out.length - 1].trim())) continue;
    out.push(l);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join('\n');
}

/**
 * @param {string[]} lines   logical lines, oldest first
 * @param {{text: string, agentId: string|null, near: number|null}} opts  text = what
 *   was typed; near = index (in lines) of the cursor's line when it was typed
 * @returns {{reply: string, truncated: boolean, echoed: boolean}}
 */
export function extractReply(lines, { text = '', agentId = null, near = null } = {}) {
  const all = (Array.isArray(lines) ? lines : []).map(l => (typeof l === 'string' ? l.replace(/\s+$/, '') : ''));
  const end = echoEnd(all, text, near);
  let body = all.slice(end + 1);
  /* The input box under the answer (and whatever is below it: footer, hints) */
  const rule = AGENT_RULES.find(r => r.id === agentId);
  if (rule) {
    const idle = lastMatch(rule.idle, body);
    if (idle >= 0) body = body.slice(0, idle);
  } else {
    let n = body.length;
    while (n > 0 && !body[n - 1].trim()) n--;
    if (n > 0 && /^\s*\S{0,12}[>❯›$#%]\s*$/u.test(body[n - 1])) body = body.slice(0, n - 1);
  }
  /* The rule line that tops Claude's input box, and blank lines, at the end */
  while (body.length && (!body[body.length - 1].trim() || RULE.test(body[body.length - 1]))) body.pop();
  let reply = cleanReply(body, { text, agentId });
  let truncated = false;
  if (reply.length > TALK_REPLY_MAX) { reply = reply.slice(-TALK_REPLY_MAX); truncated = true; }
  return { reply, truncated, echoed: end >= 0 };
}
