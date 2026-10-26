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
 *      agentRules.js, and everything under it), spinner / "Worked for 8s"
 *      lines, and runs of blank lines.
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
/* "✻ Baked for 8s", "✻ Worked for 1m 3s", and a spinner "✢ Thinking… (esc to interrupt)" */
const STATUS = [
  /^\s*[·✢✳✶✻✽*∗]\s+\S[^…]{0,40}\bfor\s+(\d+h\s*)?(\d+m\s*)?\d+s\s*$/u,
  /^\s*[·✢✳✶✻✽*∗]\s+\S[^…]{0,40}…/u,
  /\(\s*(\d+h\s*)?(\d+m\s*)?\d+s\s*•\s*esc to interrupt\)/,
  /\besc to interrupt\b/,
];

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
  body = body.filter(l => !STATUS.some(p => p.test(l)));
  const out = [];
  for (const l of body) {
    if (!l.trim() && (!out.length || !out[out.length - 1].trim())) continue;
    out.push(l);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  let reply = out.join('\n');
  let truncated = false;
  if (reply.length > TALK_REPLY_MAX) { reply = reply.slice(-TALK_REPLY_MAX); truncated = true; }
  return { reply, truncated, echoed: end >= 0 };
}
