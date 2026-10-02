/*
 * Rows of the Agents panel. Each window builds its own from its tabs (the
 * same shape goes to main, window:agents-report, which merges every window's
 * and adds windowId / windowNumber / self). Android and the browser have one
 * window: the panel reads these directly.
 */
import { isTerminalTab, paneTitle } from '../SplitPane/layoutTree';
import { tabColor } from '../HostList/hostColor';
import { AGENT_STATE_ORDER } from '../Terminal/agentRules';

export function localAgentRows(state) {
  return (state.tabs || [])
    .filter(t => t.agent && isTerminalTab(t))
    .map(t => ({
      tabId: t.id,
      agentId: t.agent.id,
      name: t.agent.name,
      state: t.agent.state,
      since: t.agent.since,
      title: paneTitle(t),
      color: tabColor(t, state.hosts) || null,
    }));
}

/** What the panel shows: {windows, rows}, sorted blocked > done > working > idle, then longest in that state */
export function panelAgentRows(state) {
  const all = state.agentsAll || { windows: 1, rows: localAgentRows(state).map(r => ({ ...r, self: true, windowNumber: 1 })) };
  const rows = [...all.rows].sort((a, b) => ((AGENT_STATE_ORDER[a.state] ?? 9) - (AGENT_STATE_ORDER[b.state] ?? 9))
    || ((a.since ?? 0) - (b.since ?? 0)));
  return { windows: all.windows, rows };
}
