import React, { useState, useEffect, useRef } from 'react';
import { useApp } from '../../contexts/AppContext';
import { FEATURES } from '../../platform';
import { layoutOf, collectIds, isTerminalTab } from '../SplitPane/layoutTree';

/*
 * Title bar "Arrange panes": a click gives every pane of the open tab the same
 * size; the chevron (or a right-click) offers Columns / Rows / Grid. Only the
 * layout tree changes (SplitPane/arrange.js): the same sessions stay in the
 * same panes, and xterm's ResizeObserver refits each one and resizes its pty.
 *
 * On the web mirror it arranges this browser's own copy only: the panes come
 * from the PC, their sizes are each browser's (Mirror/mirror.js
 * mergeMirrorLayouts), and nothing is sent to the PC. Not on Android (no
 * split panes).
 */

const Svg = ({ children }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
/* Four equal panes */
const ArrangeIcon = () => (
  <Svg><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="12" y1="3" x2="12" y2="21" /><line x1="3" y1="12" x2="21" y2="12" /></Svg>
);
const ChevronIcon = () => <Svg><polyline points="6 9 12 15 18 9" /></Svg>;

const ITEMS = [
  { mode: 'equal', label: 'Equal Sizes', hint: 'Same structure' },
  { mode: 'columns', label: 'Columns', hint: 'Side by side' },
  { mode: 'rows', label: 'Rows', hint: 'One below another' },
  { mode: 'grid', label: 'Grid', hint: 'Rows and columns' },
];

export default function ArrangeButton() {
  const { state, actions } = useApp();
  const [menu, setMenu] = useState(null);   // { top, right }
  const wrapRef = useRef(null);

  const active = state.tabs.find(t => t.id === state.activeTabId);
  const groupId = isTerminalTab(active) && !active.hidden ? active.id : null;
  const panes = groupId ? collectIds(layoutOf(state.layouts, groupId)).length : 0;
  const enabled = panes > 1;

  /* The menu belongs to the tab on screen: another tab, or down to one pane, closes it */
  useEffect(() => { if (!enabled) setMenu(null); }, [enabled, groupId]);

  useEffect(() => {
    if (!menu) return undefined;
    const close = (e) => { if (!wrapRef.current?.contains(e.target)) setMenu(null); };
    const esc = (e) => { if (e.key === 'Escape') setMenu(null); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [menu]);

  if (!FEATURES.splitPanes) return null;

  const openMenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!enabled) return;
    if (menu) { setMenu(null); return; }
    const r = wrapRef.current.getBoundingClientRect();
    setMenu({ top: r.bottom + 4, right: Math.max(4, window.innerWidth - r.right) });
  };
  const run = (mode) => { setMenu(null); actions.arrangePanes(groupId, mode); };

  const why = enabled ? null : 'Arrange panes — split this tab first';
  return (
    <div className="arrange-group" ref={wrapRef} onContextMenu={openMenu}>
      <button
        className="arrange-btn"
        disabled={!enabled}
        onClick={(e) => { e.stopPropagation(); run('equal'); }}
        title={why || 'Arrange panes — equal sizes'}
        aria-label="Arrange panes: equal sizes"
      >
        <ArrangeIcon />
      </button>
      <button
        className={`arrange-more-btn${menu ? ' open' : ''}`}
        disabled={!enabled}
        onClick={openMenu}
        title={why || 'Arrange panes as…'}
        aria-label="Arrange panes as"
        aria-haspopup="menu"
        aria-expanded={!!menu}
      >
        <ChevronIcon />
      </button>
      {menu && (
        <div className="tab-context-menu arrange-menu" role="menu" style={{ top: menu.top, right: menu.right }}>
          {ITEMS.map(it => (
            <button key={it.mode} role="menuitem" className="tab-context-menu-item" onClick={() => run(it.mode)}>
              {it.label}<span className="tab-context-menu-key">{it.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
