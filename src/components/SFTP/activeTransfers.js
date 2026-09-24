/*
 * How many transfers each SFTP tab has queued or running, so closing the tab
 * (TabBar's ×, middle click, Ctrl+W in App) can ask first. SFTPView writes it;
 * nothing else does. Module state on purpose: the tab bar is not a child of
 * the view, and a count does not belong in the app store.
 */

const counts = new Map();   // tabId -> active transfers

export function setActiveTransfers(tabId, n) {
  if (n > 0) counts.set(tabId, n);
  else counts.delete(tabId);
}

/** true = go ahead and close. Only SFTP tabs with work in flight ask. */
export function confirmCloseSftp(tab) {
  if (!tab || tab.type !== 'sftp') return true;
  const n = counts.get(tab.id) || 0;
  if (!n) return true;
  return window.confirm(`Close "${tab.label}"? ${n} ${n === 1 ? 'transfer' : 'transfers'} in progress will be cancelled.`);
}
