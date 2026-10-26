/*
 * Agent to agent, renderer half (main: electron/agent/agent-talk.js). Main
 * asks the window that owns a terminal to type a message into it, to read
 * what it answered, or to keep watching it ('agent-talk:op'); the terminal's
 * own TerminalView does it (windowMove registry → entry.talk()). The result
 * of each op, and later the end of the turn, go back with talkReply.
 * Mounted once in App, desktop only.
 */
import { useEffect } from 'react';
import { FEATURES } from '../../platform';
import { terminalEntry } from '../SplitPane/windowMove';

export function runTalkOp(op, emit) {
  const entry = terminalEntry(op.tabId);
  const talk = entry && typeof entry.talk === 'function' ? entry.talk() : null;
  if (!talk) return { ok: false, code: 'unreachable', error: 'That terminal is not open in its window any more.' };
  if (op.kind === 'send') return talk.send(op.text, op.deliveryId, emit);
  if (op.kind === 'read') return talk.read(op.deliveryId, op.text);
  if (op.kind === 'watch') return talk.watch(op.deliveryId, op.text, emit);
  return { ok: false, error: `Unknown operation ${op.kind}` };
}

export function useAgentTalk() {
  useEffect(() => {
    const a = typeof window !== 'undefined' ? window.electronAPI?.agents : null;
    if (!FEATURES.multiWindow || !a?.onTalkOp) return undefined;
    const emit = (id, payload) => { a.talkReply(id, payload).catch(() => {}); };
    const listener = a.onTalkOp((op) => {
      if (!op || typeof op.opId !== 'string' || typeof op.tabId !== 'string') return;
      let res;
      try { res = runTalkOp(op, emit); } catch (err) { res = { ok: false, error: err?.message || String(err) }; }
      a.talkReply(op.opId, res || { ok: false }).catch(() => {});
    });
    return () => a.removeTalkListener(listener);
  }, []);
}
