/*
 * Ending terminal sessions, shared by TabBar (close tab), App (Ctrl+W) and
 * SessionStage (close pane). A split tab closes all of its panes.
 *
 * Local terminals: `tab.sessionId` is a placeholder ('local-<id>') made when
 * the tab opens; the pty's real id arrives after spawn and TerminalView
 * stores it as `tab.ptySessionId`. Kill, broadcast and snippets use that one.
 */
export const liveSessionId = (tab) => (tab?.type === 'local-terminal' ? tab.ptySessionId : tab?.sessionId) || null;

/* Same rule as before splits: a live local shell (or legacy 'ssh' tab) asks */
const asks = (t) => !!t?.sessionId && (t.type === 'local-terminal' || t.type === 'ssh');

export function confirmCloseSessions(members, label) {
  const live = members.filter(asks);
  if (!live.length) return true;
  if (members.length === 1) return window.confirm(`Close "${label}"? Any running process will be terminated.`);
  return window.confirm(`Close "${label}" and its ${members.length} panes? Any running process will be terminated.`);
}

export async function endSessions(members, disconnectSession) {
  await Promise.all(members.map(async (t) => {
    if (!t.sessionId) return;
    if (t.type === 'local-terminal') {
      const sid = liveSessionId(t);
      if (sid) { try { await window.electronAPI?.localShell?.kill(sid); } catch (_) { /* already gone */ } }
    } else {
      await disconnectSession(t.sessionId);
    }
  }));
}

/*
 * Tabs closed while their SSH session was still being opened (connecting, or
 * waiting on the host-key prompt). There is no IPC to cancel a pending
 * ssh:connect by tab, so the connect is left to finish and whatever it
 * returns is disconnected at once instead of being added. (Local panes: the
 * pty that `spawn` returns after the pane unmounted is killed in TerminalView.)
 */
const abandoned = new Set();

/* Called with the tabs as they are just before `ids` close */
export function markAbandoned(tabs, ids) {
  for (const id of [].concat(ids)) {
    if (tabs.some(t => t.id === id && t.connecting)) abandoned.add(id);
  }
}

/* ssh.connect for tab `tabId`, then either adopt the session (ADD_SESSION +
   UPDATE_TAB) or, if the tab closed meanwhile, disconnect it and add nothing. */
export async function connectTab({ tabId, host, config, ssh, dispatch }) {
  try {
    const { sessionId } = await ssh.connect(config);
    if (abandoned.delete(tabId)) {
      try { await ssh.disconnect(sessionId); } catch (_) { /* already gone */ }
      return { tabId, sessionId: null, abandoned: true };
    }
    dispatch({ type: 'ADD_SESSION', payload: { sessionId, hostId: host.id, host, status: 'connected' } });
    /* Update the tab with the sessionId and mark as connected */
    dispatch({ type: 'UPDATE_TAB', payload: { id: tabId, sessionId, connecting: false } });
    return { tabId, sessionId };
  } catch (err) {
    /* Closed while connecting and then it failed (or the prompt was refused): nothing to report */
    if (abandoned.delete(tabId)) return { tabId, sessionId: null, abandoned: true };
    console.error('SSH connection failed:', err);
    dispatch({ type: 'UPDATE_TAB', payload: { id: tabId, connecting: false, error: err.message } });
    throw err;
  }
}
