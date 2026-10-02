/*
 * Rows of the Sessions dock: every terminal (each pane of a split tab, SSH and
 * local) in the order of the tab bar. Each window builds its own from its
 * tabs; the same shape goes to main (window:agents-report, a name from when
 * the panel listed only agents), which merges every window's in window order
 * and adds windowId / windowNumber / self. Android and the browser have one
 * window: they read these directly. The agent fields are null unless an
 * agent CLI was recognised in that terminal.
 */
import { isTerminalTab, memberTabs, paneTitle, cleanAlias } from '../SplitPane/layoutTree';
import { tabColor } from '../HostList/hostColor';

export function localSessionRows(state) {
  const rows = [];
  for (const tab of (state.tabs || [])) {
    if (tab.hidden || !isTerminalTab(tab)) continue;
    for (const t of memberTabs(state, tab.id)) {
      rows.push({
        tabId: t.id,
        groupId: tab.id,
        kind: t.type === 'local-terminal' ? 'local' : 'ssh',
        connected: !!t.sessionId,
        muted: !!t.muted,
        title: paneTitle(t),
        alias: cleanAlias(t.alias) || null,
        host: t.label || 'Terminal',
        color: tabColor(t, state.hosts) || null,
        agentId: t.agent ? t.agent.id : null,
        name: t.agent ? t.agent.name : null,
        state: t.agent ? t.agent.state : null,
        since: t.agent ? t.agent.since : null,
      });
    }
  }
  return rows;
}

/** What the dock shows: {windows, rows}, in tab-bar order, window by window */
export function panelSessionRows(state) {
  return state.agentsAll || { windows: 1, rows: localSessionRows(state).map(r => ({ ...r, self: true, windowNumber: 1 })) };
}

/** Rows that need the user: an agent waiting for an answer */
export const isWaiting = (r) => r.state === 'blocked';
