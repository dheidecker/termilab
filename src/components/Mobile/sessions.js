/*
 * Open sessions on Android: the terminal tabs, which the Sessions screen lists
 * and the bottom nav counts. Same close path as the desktop tab strip
 * (confirm, ssh:disconnect, remove the tab).
 */

export const sessionTabs = (tabs) => tabs.filter(t => (t.type === 'terminal' || t.type === 'ssh') && !t.hidden);

/** 'connecting' | 'connected' | 'closed' | 'failed' */
export function sessionStatus(tab) {
  if (tab.error) return 'failed';
  if (tab.connecting || !tab.sessionId) return 'connecting';
  if (tab.closed) return 'closed';
  return 'connected';
}

export const STATUS_LABEL = {
  connecting: 'Connecting…',
  connected: 'Connected',
  closed: 'Disconnected',
  failed: 'Failed',
};

/**
 * @param {object} tab
 * @param {object} actions  useApp().actions
 * @param {{confirm?: boolean}} [opts]
 * @returns {Promise<boolean>} whether it closed
 */
export async function closeSessionTab(tab, actions, { confirm = true } = {}) {
  const live = sessionStatus(tab) === 'connected';
  if (confirm && live && !window.confirm(`Close "${tab.label}"? Any running process will be terminated.`)) return false;
  if (tab.sessionId) await actions.disconnectSession(tab.sessionId);
  actions.removeTab(tab.id);
  return true;
}
