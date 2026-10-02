/*
 * What the Sessions dock's row menu does: Rename, Color, Mute, Close. A row
 * of this window acts here; one of another window goes through main
 * (window:session-action) and THAT window applies it (window:session-request,
 * heard by useSessionRequests, mounted once in App on desktop). Close asks
 * there, with that window's own dialogs (main focuses it first).
 */
import { useEffect, useRef } from 'react';
import { useApp } from '../../contexts/AppContext';
import { FEATURES } from '../../platform';
import { paneName } from '../SplitPane/layoutTree';
import { confirmCloseSessions, endSessions } from '../SplitPane/sessions';
import { planKeeperClose } from '../Keeper/closePlan';

/* One terminal, like a pane header's Close Pane (a standalone tab: the tab) */
export async function closeSessionPane(tab, { disconnectSession, removeTab }) {
  if (!tab) return;
  if (!confirmCloseSessions([tab], paneName(tab))) return;
  const plan = await planKeeperClose([tab]);
  if (!plan) return;
  await endSessions([tab], disconnectSession, plan);
  removeTab(tab.id);
}

function applyHere(tabId, action, value, { state, actions }) {
  const tab = state.tabs.find(t => t.id === tabId);
  if (!tab) return false;
  if (action === 'rename') actions.setTabAlias(tabId, value || '');
  else if (action === 'color') return actions.setTabColor(tabId, value || null);
  else if (action === 'mute') actions.setTabMuted(tabId, !!value);
  else if (action === 'close') return closeSessionPane(tab, actions);
  else return false;
  return true;
}

/* action: rename (value: the alias, '' = none) | color (#rrggbb | null) | mute (bool) | close */
export function runSessionAction(row, action, value, ctx) {
  if (!row || !row.tabId) return Promise.resolve(false);
  if (row.self !== false || !FEATURES.multiWindow) return Promise.resolve(applyHere(row.tabId, action, value, ctx));
  return window.electronAPI.window.sessionAction({ windowId: row.windowId, tabId: row.tabId, action, value: value ?? null });
}

/* Another window's dock acting on a terminal of this one */
export function useSessionRequests() {
  const { state, actions } = useApp();
  const ctx = useRef({ state, actions });
  ctx.current = { state, actions };
  useEffect(() => {
    if (!FEATURES.multiWindow) return undefined;
    const w = window.electronAPI.window;
    const listener = w.onSessionRequest((p) => {
      if (!p || typeof p.tabId !== 'string') return;
      Promise.resolve(applyHere(p.tabId, p.action, p.value, ctx.current))
        .catch(err => console.error('[sessions] request failed:', err?.message));
    });
    return () => w.offEvents(listener);
  }, []);
}
