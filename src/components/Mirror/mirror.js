/*
 * Web mirror, renderer side (main side: electron/web/mirror.js).
 *
 * PC window (the source of truth): useMirrorSource() reports its terminal
 * tabs — with each one's LIVE session id and state — on every change
 * (mirror:report), runs the orders browsers send it (mirror:command) through
 * the normal actions (connectToHost → connectTab, the local pty spawn,
 * endSessions…), and shows a notice when a browser connects.
 *
 * Browser (IS_WEB): AppContext replaces its tabs with the PC's on every
 * mirror:state (applyMirrorState) and turns its tab actions into orders
 * (mirrorActions). Which tab is open and which pane has the keyboard stay
 * the browser's own; opening a tab from the browser does not switch the PC.
 */
import { useEffect, useRef } from 'react';
import { IS_ANDROID, IS_WEB } from '../../platform';
import { liveSessionId, endSessions, takeMirrorEnd } from '../SplitPane/sessions';
import { showToast } from '../Keeper/toast';

const isTerminal = (t) => !!t && (t.type === 'terminal' || t.type === 'local-terminal');

/** PC: what a browser needs to show this window's terminals (no secrets, no hostConfig). */
export function mirrorSnapshot(state) {
  const tabs = state.tabs.filter(isTerminal).map(t => ({
    id: t.id,
    type: t.type,
    label: t.label || null,
    alias: t.alias || null,
    color: t.color || null,
    muted: !!t.muted,
    hidden: !!t.hidden,
    hostId: t.hostId || null,
    sessionId: liveSessionId(t),
    connecting: !!t.connecting,
    error: t.error || null,
    elsewhere: !!t.elsewhere,
    kept: !!t.kept,
    sessionKey: t.sessionKey || null,
  }));
  return { tabs, layouts: state.layouts || {}, focusedPane: state.focusedPane || {} };
}

/* What the browser keeps of its own copy of a tab across states: marks it
   computed from the stream itself (agent detection, done/bell marks) */
const OWN = ['doneAt', 'doneKind', 'notify', 'agent'];

/** Browser: rows of the Sessions panel, `self` = the window this browser mirrors. */
export function markMirrorRows(agentsAll, windowId) {
  if (!agentsAll || !Array.isArray(agentsAll.rows)) return agentsAll;
  return { ...agentsAll, rows: agentsAll.rows.map(r => ({ ...r, self: windowId != null && r.windowId === windowId })) };
}

/** Browser reducer step: the PC window's tabs (`p` = mirror:state) into this state. */
export function applyMirrorState(state, p) {
  if (!p || !Array.isArray(p.tabs)) return state;
  const prev = new Map(state.tabs.map(t => [t.id, t]));
  const tabs = p.tabs.map((m) => {
    const old = prev.get(m.id);
    const local = m.type === 'local-terminal';
    const t = {};
    if (old) for (const k of OWN) if (old[k] !== undefined) t[k] = old[k];
    Object.assign(t, {
      id: m.id,
      type: m.type,
      label: m.label || (local ? 'Local Terminal' : 'Terminal'),
      hostId: m.hostId || undefined,
      hidden: !!m.hidden,
      muted: !!m.muted,
      kept: !!m.kept,
      sessionKey: m.sessionKey || undefined,
      alias: m.alias || null,
      connecting: !!m.connecting,
      error: m.error || null,
      elsewhere: !!m.elsewhere,
      /* Same shape as the PC's tab: a local one's sessionId is a placeholder,
         the pty's id is ptySessionId (liveSessionId reads either) */
      sessionId: local ? `local-${m.id}` : (m.sessionId || null),
      ptySessionId: local ? (m.sessionId || null) : undefined,
      mirror: true,
    });
    if (m.color) t.color = m.color;
    return t;
  });
  const layouts = p.layouts && typeof p.layouts === 'object' ? p.layouts : {};
  const ids = new Set(tabs.map(t => t.id));
  const visible = tabs.filter(t => !t.hidden);
  /* This client's own tab and focus: kept while they exist */
  const pending = state.mirror && state.mirror.pending;
  let activeTabId = state.activeTabId;
  let nextPending = pending || null;
  if (pending && visible.some(t => t.id === pending)) { activeTabId = pending; nextPending = null; }
  else if (activeTabId !== null && !visible.some(t => t.id === activeTabId)) {
    /* A pane of a split (or its group renamed): the group that holds it, else a neighbour */
    const holder = Object.keys(layouts).find(g => JSON.stringify(layouts[g]).includes(`"tabId":${JSON.stringify(activeTabId)}`));
    activeTabId = holder && ids.has(holder) ? holder : (visible[0] ? visible[0].id : null);
  }
  const focusedPane = {};
  for (const g of Object.keys(layouts)) {
    const tree = JSON.stringify(layouts[g]);
    const mine = state.focusedPane && state.focusedPane[g];
    if (mine && tree.includes(`"tabId":${JSON.stringify(mine)}`)) focusedPane[g] = mine;
    else if (p.focusedPane && p.focusedPane[g]) focusedPane[g] = p.focusedPane[g];
  }
  const mirror = { windowId: p.windowId ?? null, number: p.number ?? null, windows: Array.isArray(p.windows) ? p.windows : [], pending: nextPending, ready: true };
  return {
    ...state,
    tabs,
    layouts,
    focusedPane,
    activeTabId,
    mirror,
    agentsAll: state.agentsAll ? markMirrorRows(state.agentsAll, mirror.windowId) : state.agentsAll,
  };
}

/* A size for a terminal the PC opens for this browser (the PC's pane may be
   hidden, and then this is the size its shell starts at): a guess from this
   window, as the terminal area would fit it. Typing here makes this
   client's real size win anyway (the conductor, window-registry.js). */
function browserSize() {
  const w = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const h = typeof window !== 'undefined' ? window.innerHeight : 800;
  return { cols: Math.max(40, Math.min(300, Math.floor((w - 40) / 8.4))), rows: Math.max(10, Math.min(120, Math.floor((h - 120) / 17))) };
}

/** Browser: the tab actions as orders to the PC window (AppContext merges them over its own). */
export function mirrorActions(dispatch) {
  const api = () => window.electronAPI.mirror;
  const send = (cmd) => api().command(cmd).catch((err) => {
    showToast(`The PC did not take it: ${err?.message || err}`);
    throw err;
  });
  const fresh = () => crypto.randomUUID();
  const opening = (tabId) => dispatch({ type: 'MIRROR_PENDING', payload: tabId });
  return {
    connectToHost: async (host) => {
      const tabId = fresh();
      opening(tabId);
      await send({ type: 'open-host', hostId: host.id, tabId, ...browserSize() });
      return { tabId, sessionId: null };
    },
    openLocalTerminal: () => {
      const tabId = fresh();
      opening(tabId);
      send({ type: 'open-local', tabId, ...browserSize() }).catch(() => {});
      return tabId;
    },
    removeTab: (ids) => {
      const tabIds = [].concat(ids);
      const end = takeMirrorEnd(tabIds);
      /* Gone here at once; the PC's next state says what really happened */
      dispatch({ type: 'REMOVE_TAB', payload: tabIds });
      send({ type: 'close', tabIds, end }).catch(() => {});
    },
    disconnectSession: async () => {},
    setTabAlias: (tabId, alias) => { send({ type: 'rename', tabId, alias: alias || '' }).catch(() => {}); },
    setTabColor: async (tabId, color) => { await send({ type: 'color', tabId, color: color && color !== 'none' ? color : null }); return null; },
    setTabMuted: (tabId, muted) => { send({ type: 'mute', tabId, muted: !!muted }).catch(() => {}); },
    splitPane: (groupId, paneId, direction) => {
      send({ type: 'split', groupId, paneId, direction, tabId: fresh(), ...browserSize() }).catch(() => {});
    },
    reopenBackgroundSession: async (rec) => {
      const tabId = fresh();
      opening(tabId);
      await send({ type: 'reopen', keeperId: rec.keeperId, tabId, ...browserSize() });
      return { tabId };
    },
    endBackgroundSession: async (rec) => { await send({ type: 'background-end', keeperId: rec.keeperId }); return true; },
    /* Needs a connection of its own: the PC's tab has the button */
    takeOverSession: async () => null,
  };
}

/** PC: run a browser's order (already validated in main) the normal way. */
export async function runMirrorCommand(cmd, { state, actions }) {
  if (!cmd || typeof cmd !== 'object') return false;
  const has = (id) => state.tabs.some(t => t.id === id);
  const spawnSize = cmd.cols && cmd.rows ? { cols: cmd.cols, rows: cmd.rows } : null;
  const opts = { tabId: cmd.tabId, noSwitch: true, spawnSize };
  switch (cmd.type) {
    case 'open-host': {
      if (has(cmd.tabId)) return false;
      const host = state.hosts.find(h => h.id === cmd.hostId);
      if (!host) throw new Error('No such host');
      await actions.connectToHost(host, opts);
      return true;
    }
    case 'open-local':
      if (has(cmd.tabId)) return false;
      actions.openLocalTerminal(opts);
      return true;
    case 'close': {
      const members = state.tabs.filter(t => cmd.tabIds.includes(t.id));
      if (!members.length) return false;
      /* The browser asked (its own confirm and keep/end question): no dialog here */
      await endSessions(members, actions.disconnectSession, { end: new Set(cmd.end || []) });
      actions.removeTab(members.map(t => t.id));
      return true;
    }
    case 'rename': if (!has(cmd.tabId)) return false; actions.setTabAlias(cmd.tabId, cmd.alias || ''); return true;
    case 'color': if (!has(cmd.tabId)) return false; await actions.setTabColor(cmd.tabId, cmd.color || null); return true;
    case 'mute': if (!has(cmd.tabId)) return false; actions.setTabMuted(cmd.tabId, !!cmd.muted); return true;
    case 'split':
      if (!has(cmd.groupId) || !has(cmd.paneId) || has(cmd.tabId)) return false;
      actions.splitPane(cmd.groupId, cmd.paneId, cmd.direction, opts);
      return true;
    case 'reopen': {
      if (has(cmd.tabId)) return false;
      const rec = (state.backgroundSessions || []).find(r => r.keeperId === cmd.keeperId);
      if (!rec) throw new Error('That background session is no longer listed');
      await actions.reopenBackgroundSession(rec, opts);
      return true;
    }
    case 'background-end': {
      const rec = (state.backgroundSessions || []).find(r => r.keeperId === cmd.keeperId);
      if (!rec) return false;
      await actions.endBackgroundSession(rec);
      return true;
    }
    default:
      return false;
  }
}

/** PC (desktop window, never a browser or Android): mounted once in App. */
export function useMirrorSource(state, actions) {
  const ctx = useRef({ state, actions });
  ctx.current = { state, actions };
  const m = !IS_WEB && !IS_ANDROID && typeof window !== 'undefined' ? window.electronAPI?.mirror : null;
  const key = m && !state.loading ? JSON.stringify(mirrorSnapshot(state)) : '';
  useEffect(() => {
    if (!m || !key) return undefined;
    const t = setTimeout(() => { m.report(JSON.parse(key)).catch(() => {}); }, 50);
    return () => clearTimeout(t);
  }, [key]);
  useEffect(() => {
    if (!m || typeof m.onCommand !== 'function') return undefined;
    const on = m.onCommand((cmd) => {
      runMirrorCommand(cmd, ctx.current).catch(err => console.error('[mirror] command failed:', err?.message));
    });
    return () => m.offEvents(on);
  }, []);
  /* "A browser connected: <login>" */
  useEffect(() => {
    const w = !IS_WEB && typeof window !== 'undefined' ? window.electronAPI?.web : null;
    if (!w || typeof w.onClients !== 'function') return undefined;
    const on = w.onClients((p) => {
      if (p && p.connected) showToast(`A browser connected: ${p.connected.login || 'unknown user'}`, 5000);
    });
    return () => w.offClients(on);
  }, []);
}
