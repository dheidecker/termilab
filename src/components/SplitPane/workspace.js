/*
 * Workspace restore, renderer half (desktop). Pure: no React, no electronAPI;
 * the harness bundles it with esbuild (scripts/lib/check-workspace.js).
 *
 *   snapshotWindow(state)   what this window reports to main (it adds bounds)
 *   restorePlan(saved, hosts)  what to recreate from a saved window, and in
 *                              which order to reconnect
 *
 * Per terminal tab only: kind (host | local | quick), host id, label, alias,
 * colour, mute, hidden (a pane of a split), sessionKey. Never scrollback,
 * never a password: a quick connect (not a saved host) is remembered only to
 * say on restore that it was not reconnected. SFTP tabs are not restored.
 */
import * as Layout from './layoutTree';

/* Delay between two restored reconnects: many tabs must not stampede */
export const RECONNECT_STAGGER_MS = 150;

const isTerm = (t) => !!t && (t.type === 'terminal' || t.type === 'local-terminal');

/* `user@host:port` of a quick connect, for the note on restore (no secrets) */
function quickTarget(t) {
  const h = t.hostConfig || {};
  if (!h.hostname) return null;
  const port = h.port && Number(h.port) !== 22 ? `:${h.port}` : '';
  return `${h.username ? `${h.username}@` : ''}${h.hostname}${port}`;
}

/** {tabs, layouts, activeTabId, focusedPane} of this window, for main to save */
export function snapshotWindow(state) {
  const hosts = new Set((state.hosts || []).map(h => h.id));
  /* What is not a terminal, or is a "not reconnected" note, leaves the model
     first (removeTabs promotes heirs, so the layouts stay consistent) */
  const drop = state.tabs.filter(t => !isTerm(t) || t.skipped).map(t => t.id);
  const { model } = drop.length ? Layout.removeTabs(state, drop) : { model: state };
  const tabs = model.tabs.map((t) => {
    const out = { id: t.id, label: t.label || null, sessionKey: t.sessionKey || t.id };
    if (t.type === 'local-terminal') out.kind = 'local';
    else if (t.hostId && hosts.has(t.hostId)) { out.kind = 'host'; out.hostId = t.hostId; }
    else { out.kind = 'quick'; const target = quickTarget(t); if (target) out.target = target; }
    const alias = Layout.cleanAlias(t.alias);
    if (alias) out.alias = alias;
    if (typeof t.color === 'string' && t.color) out.color = t.color;
    if (t.muted) out.muted = true;
    if (t.hidden) out.hidden = true;
    return out;
  });
  const ids = new Set(tabs.map(t => t.id));
  const layouts = {};
  for (const [g, tree] of Object.entries(model.layouts || {})) if (ids.has(g)) layouts[g] = tree;
  const focusedPane = {};
  for (const [g, p] of Object.entries(state.focusedPane || {})) if (layouts[g] && ids.has(p)) focusedPane[g] = p;
  const active = tabs.find(t => t.id === state.activeTabId && !t.hidden);
  return { tabs, layouts, activeTabId: active ? active.id : null, focusedPane };
}

/*
 * From a saved window to tabs ready for the reducer:
 *  - host tab, host still saved   → terminal tab `connecting`, reconnected
 *  - host tab, host deleted since → dropped (its split heals, as on close)
 *  - local                        → a local terminal (a fresh shell)
 *  - quick                        → a note in the tab: not reconnected
 * → { tabs, layouts, activeTabId, focusedPane, connect: [tabId…], dropped: [id…] }
 * `connect` order: the active tab's panes first, then the bar left to right,
 * each tab's panes in layout order.
 */
export function restorePlan(saved, hosts) {
  const empty = { tabs: [], layouts: {}, activeTabId: null, focusedPane: {}, connect: [], dropped: [] };
  if (!saved || !Array.isArray(saved.tabs)) return empty;
  const byId = new Map((hosts || []).map(h => [h.id, h]));
  const tabs = [];
  const dropped = [];
  for (const s of saved.tabs) {
    if (!s || typeof s.id !== 'string' || tabs.some(t => t.id === s.id)) continue;
    const common = { id: s.id, sessionKey: s.sessionKey || s.id };
    if (s.alias) common.alias = s.alias;
    if (s.color) common.color = s.color;
    if (s.muted) common.muted = true;
    if (s.hidden) common.hidden = true;
    if (s.kind === 'local') {
      tabs.push({ ...common, type: 'local-terminal', label: s.label || 'Local Terminal', sessionId: `local-${s.id}` });
    } else if (s.kind === 'host') {
      const host = byId.get(s.hostId);
      if (!host) { dropped.push(s.id); tabs.push({ ...common, type: 'terminal', label: s.label || 'Terminal' }); continue; }
      tabs.push({
        ...common, type: 'terminal', label: host.label || host.hostname, sessionId: null,
        hostId: host.id, connecting: true, hostConfig: host,
      });
    } else if (s.kind === 'quick') {
      tabs.push({
        ...common, type: 'terminal', label: s.label || s.target || 'Quick connect', sessionId: null,
        connecting: false, skipped: true,
        error: `${s.target || 'This quick connection'} was not reconnected: it is not a saved host. Connect to it again from Hosts.`,
      });
    }
  }
  const ids = new Set(tabs.map(t => t.id));
  /* Layouts whose every leaf is here, once; anything else is discarded and its panes become tabs */
  const layouts = {};
  const placed = new Set();
  for (const [g, tree] of Object.entries(saved.layouts || {})) {
    const leaves = Layout.collectIds(tree);
    const tab = tabs.find(t => t.id === g);
    if (!tab || tab.hidden || leaves.length < 2 || !leaves.includes(g)) continue;
    if (leaves.some(id => !ids.has(id) || placed.has(id))) continue;
    leaves.forEach(id => placed.add(id));
    layouts[g] = tree;
  }
  for (const t of tabs) if (t.hidden && !placed.has(t.id)) delete t.hidden;
  let state = {
    tabs, layouts,
    activeTabId: typeof saved.activeTabId === 'string' ? saved.activeTabId : null,
    focusedPane: { ...(saved.focusedPane || {}) },
  };
  if (dropped.length) state = Layout.applyModel(state, Layout.removeTabs(state, dropped));
  else state = Layout.applyModel(state, { model: { ...state, tabs: [...state.tabs] }, renamed: {} });
  /* Home stays home (null); a saved tab that is gone hands over to the first one */
  if (state.activeTabId && !state.tabs.some(t => t.id === state.activeTabId && !t.hidden)) {
    state.activeTabId = state.tabs.find(t => !t.hidden)?.id ?? null;
  }
  /* Reconnect order */
  const visible = state.tabs.filter(t => !t.hidden);
  const groups = state.activeTabId
    ? [state.activeTabId, ...visible.map(t => t.id).filter(id => id !== state.activeTabId)]
    : visible.map(t => t.id);
  const connect = [];
  for (const g of groups) {
    for (const id of Layout.collectIds(Layout.layoutOf(state.layouts, g))) {
      const t = state.tabs.find(x => x.id === id);
      if (t && t.type === 'terminal' && t.connecting) connect.push(id);
    }
  }
  return {
    tabs: state.tabs, layouts: state.layouts, activeTabId: state.activeTabId,
    focusedPane: state.focusedPane || {}, connect, dropped,
  };
}

/*
 * Call fn(id, i) for each id, `delayMs` apart (the first at once). Resolves
 * once the LAST call has been made, not when the connects finish: those wait
 * on host-key prompts and passwords, and the restore-loop guard only needs to
 * know the restore got this far. A throwing fn does not stop the rest.
 */
export function runStaggered(ids, fn, delayMs = RECONNECT_STAGGER_MS, timer = setTimeout) {
  return new Promise((resolve) => {
    if (!ids.length) { resolve(0); return; }
    ids.forEach((id, i) => {
      timer(() => {
        try {
          const r = fn(id, i);
          if (r && typeof r.catch === 'function') r.catch(() => {});
        } catch (_) { /* one tab failing to start does not stop the others */ }
        if (i === ids.length - 1) resolve(ids.length);
      }, i * delayMs);
    });
  });
}
