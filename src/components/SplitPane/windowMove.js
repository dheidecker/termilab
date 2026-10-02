/*
 * Moving a tab (all its panes) to another window, without reconnecting.
 * Desktop only (FEATURES.multiWindow). The main-process half and the reason
 * nothing is lost is electron/window-registry.js; this is the renderer half.
 *
 *   source  moveBegin(sessions)   main buffers their output from here on,
 *                                 and pushes a mark behind what it already sent
 *   source  on the mark: snapshot every pane: flush xterm's write queue, then
 *                                 SerializeAddon (scrollback, cursor, modes)
 *   source  moveTransfer          {target, adoption: tabs + layout + screens}
 *   target  ADOPT_GROUP, moveAdopted, then per pane TerminalView writes the
 *           screen into a fresh xterm and calls moveReady → main flushes the
 *           buffer to the target and routes the session there
 *   source  'window:move-done' → drops the tabs WITHOUT ending the sessions
 *
 * An xterm cannot cross windows, so the target's is new: what travels is its
 * serialized screen. Search, selection and session logging stay behind.
 */
import { memberTabs, isTerminalTab } from './layoutTree';
import { liveSessionId } from './sessions';

const api = () => (typeof window !== 'undefined' ? window.electronAPI?.window : null);

/* ── Terminals of this window, by tab id (TerminalView registers its own) ── */
const terminals = new Map();

/** entry = { snapshot(): Promise<{data, cols, rows, connected}> } */
export function registerTerminal(tabId, entry) {
  terminals.set(tabId, entry);
  return () => { if (terminals.get(tabId) === entry) terminals.delete(tabId); };
}

/* ── Sessions an SFTP pane of this window borrows from a terminal tab ──
   (connectSftp, owned: false). Main sends a session's close only to the
   window that owns it, and the pane needs that close, so a tab whose session
   is borrowed does not move: cannotMove says why. */
const borrowed = new Map();   // sessionId -> count
export function borrowSession(sessionId) {
  if (!sessionId) return () => {};
  borrowed.set(sessionId, (borrowed.get(sessionId) || 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (borrowed.get(sessionId) || 1) - 1;
    if (n > 0) borrowed.set(sessionId, n); else borrowed.delete(sessionId);
  };
}

/* ── This window ── */
let self = null;
let selfPromise = null;
export function windowInfo() {
  if (self) return Promise.resolve(self);
  if (!api()?.info) return Promise.resolve(null);
  if (!selfPromise) {
    selfPromise = api().info().then((info) => { self = info; return info; }).catch(() => { selfPromise = null; return null; });
  }
  return selfPromise;
}
export const selfWindowId = () => self?.id ?? null;

/** Why a tab cannot move (shown disabled in the menu), or null. */
export function cannotMove(state, groupId) {
  const tab = state.tabs.find(t => t.id === groupId);
  if (!isTerminalTab(tab)) return 'Only terminal tabs can move to another window';
  const members = memberTabs(state, groupId);
  if (members.some(t => t.connecting)) return 'Wait until it has connected';
  if (members.some(t => t.type === 'local-terminal' && t.sessionId && !t.ptySessionId && !t.error)) return 'Wait until the shell has started';
  if (members.some(t => t.moving)) return 'Already moving';
  if (members.some(t => borrowed.has(liveSessionId(t)))) return 'An SFTP pane in this window is using this connection: close it first';
  return null;
}

/* Moves this window started: moveId -> { tabIds, sessionIds } */
const pending = new Map();

/* 'window:move-mark' pushes: main sends one per move right after it starts
   buffering, on the same ordered pipe as the session data. Only once it is
   here has every earlier byte reached this renderer: the beginMove REPLY can
   overtake data pushes (invoke replies and pushes are not ordered), and a
   snapshot taken on the reply lost a chunk in the e2e. */
const marks = new Set();
const markWaiters = new Map();
let markListener = null;
function ensureMarkListener() {
  const w = api();
  if (markListener || !w?.onMoveMark) return;
  markListener = w.onMoveMark(({ moveId }) => {
    const wake = markWaiters.get(moveId);
    if (wake) { markWaiters.delete(moveId); wake(); } else marks.add(moveId);
  });
}
function waitForMark(moveId, ms = 5000) {
  if (marks.delete(moveId)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { markWaiters.delete(moveId); reject(new Error('The other window did not answer in time')); }, ms);
    markWaiters.set(moveId, () => { clearTimeout(timer); resolve(); });
  });
}

/**
 * Move the tab `groupId` (with its split panes) to window `target` (an id
 * from window.list(), or 'new' with an optional screen point {x, y}).
 * `index` = position among the target's visible tabs (null: at the end).
 */
export async function moveTabToWindow({ state, dispatch, groupId, target = 'new', x, y, index = null }) {
  const w = api();
  if (!w?.moveBegin) throw new Error('This build cannot open more windows');
  const why = cannotMove(state, groupId);
  if (why) throw new Error(why);
  const members = memberTabs(state, groupId);
  const sessionIds = [...new Set(members.map(liveSessionId).filter(Boolean))];

  ensureMarkListener();
  const moveId = await w.moveBegin(sessionIds);
  pending.set(moveId, { tabIds: members.map(t => t.id), sessionIds });
  for (const t of members) dispatch({ type: 'UPDATE_TAB', payload: { id: t.id, moving: true } });
  try {
    /* After the mark, everything main sent before buffering is in this
       renderer; each snapshot then waits for xterm to parse its queue. */
    await waitForMark(moveId);
    const screens = {};
    for (const t of members) {
      const term = terminals.get(t.id);
      screens[t.id] = term ? await term.snapshot() : null;
    }
    const sessions = {};
    for (const sid of sessionIds) {
      if (state.activeSessions[sid]) sessions[sid] = state.activeSessions[sid];
    }
    const adoption = {
      groupId,
      index: Number.isInteger(index) ? index : null,
      layout: state.layouts[groupId] || null,
      focusedPane: state.focusedPane[groupId] || null,
      sessions,
      sessionIds,
      tabs: members.map((t) => {
        // eslint-disable-next-line no-unused-vars
        const { moving, notify, adopt, doneAt, doneKind, ...rest } = t;
        return { ...rest, adopt: screens[t.id] ? { ...screens[t.id] } : { data: '', connected: false } };
      }),
    };
    await w.moveTransfer(moveId, { target, x, y, adoption });
  } catch (err) {
    pending.delete(moveId);
    try { await w.moveAbort(moveId); } catch (_) { /* already gone */ }
    for (const t of members) dispatch({ type: 'UPDATE_TAB', payload: { id: t.id, moving: false } });
    throw err;
  }
  return moveId;
}

/**
 * The source side's pushes: done → drop the tabs (the sessions live on in the
 * other window); aborted → they stay here, with whatever main buffered meanwhile
 * already written to them. Also the target side's abort (drop what it adopted).
 * Returns the unsubscribe.
 */
export function listenForMoves({ dispatch, getState }) {
  const w = api();
  if (!w?.onMoveDone) return () => {};
  ensureMarkListener();
  const done = w.onMoveDone(({ moveId }) => {
    const p = pending.get(moveId);
    if (!p) return;
    pending.delete(moveId);
    dispatch({ type: 'REMOVE_TAB', payload: p.tabIds });
    for (const sid of p.sessionIds) dispatch({ type: 'REMOVE_SESSION', payload: sid });
  });
  const aborted = w.onMoveAborted(({ moveId }) => {
    const p = pending.get(moveId);
    if (p) {
      /* Everything stays: main hands a tab over all-or-nothing, so an
         aborted move never gave any of its panes to the target. */
      pending.delete(moveId);
      for (const id of p.tabIds) dispatch({ type: 'UPDATE_TAB', payload: { id, moving: false } });
      return;
    }
    /* We were the target: drop the tabs we adopted for it, end nothing */
    const st = getState();
    const ids = st.tabs.filter(t => t.adopt && t.adopt.moveId === moveId).map(t => t.id);
    if (ids.length) dispatch({ type: 'REMOVE_TAB', payload: ids });
  });
  return () => { w.offEvents(done); w.offEvents(aborted); };
}

/** Target side: take what main queued for this window, then follow the pushes. */
export function listenForAdoptions({ dispatch }) {
  const w = api();
  if (!w?.onAdopt) return () => {};
  const adopt = (a) => {
    if (!a || !a.moveId || !Array.isArray(a.tabs)) return;
    dispatch({ type: 'ADOPT_GROUP', payload: {
      ...a,
      tabs: a.tabs.map(t => ({ ...t, adopt: { ...(t.adopt || {}), moveId: a.moveId } })),
    } });
    w.moveAdopted(a.moveId).catch(() => {});
  };
  const listener = w.onAdopt(adopt);
  w.takeAdoptions().then((list) => (list || []).forEach(adopt)).catch(() => {});
  return () => w.offEvents(listener);
}

/** TerminalView, once an adopted pane shows its screen and listens. */
export function adoptedReady(moveId, sessionId) {
  if (!moveId || !sessionId) return;
  api()?.moveReady?.(moveId, sessionId).catch(() => {});
}

/* ── Cross-window tab drag ──
   The drag payload carries the source window id. A drop on ANOTHER window
   asks main to make the source move the tab there (only the source can
   serialize its terminals). A drag nobody accepted asks main where the
   pointer ended (dropTarget): outside every window → a new window there;
   over another Termilab window → that one; over this one → nothing. */
export function requestMoveHere({ fromWindowId, tabId, index }) {
  return api()?.requestMove?.({ fromWindowId, tabId, index });
}

/** After a tab drag nobody accepted: {kind: 'self'|'window'|'outside', id?, x, y} */
export function dropTarget() {
  return api()?.dropTarget ? api().dropTarget() : Promise.resolve(null);
}
