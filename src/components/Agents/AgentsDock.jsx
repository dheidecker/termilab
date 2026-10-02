import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../../contexts/AppContext';
import { CloseIcon } from '../Icons/icons';
import { FEATURES } from '../../platform';
import { agentElapsed, AGENT_STATE_LABEL } from '../Terminal/agentRules';
import { isTerminalTab, focusedPaneOf } from '../SplitPane/layoutTree';
import InlineRename from '../SplitPane/InlineRename';
import { cannotMove } from '../SplitPane/windowMove';
import { ColorPopover, anchorOf } from '../ColorPicker/ColorPicker';
import { panelSessionRows, isWaiting } from './sessionRows';
import { runSessionAction } from './sessionActions';
import AgentDot from './AgentDot';
import './Agents.css';
/* The row menu uses the tab/pane context menu look */
import '../TabBar/TabBar.css';

/*
 * The Sessions dock (desktop): a narrow column next to the sidebar that stays
 * open over whatever is on screen. Every open terminal (each pane, SSH and
 * local) of every window, in tab-bar order, window by window; the agent state
 * where an agent CLI was recognised, and an amber row where one waits for the
 * user. A click focuses that terminal (its window first, when it is another
 * one) and the dock stays. Right-click: Rename… (the session alias, as in the
 * pane header), Color, Mute, Move to New Window, Close; for another window's
 * row main hands the action to that window. Width: drag the right edge.
 */
const WIDTH_KEY = 'termilab.agentsDock.width';
export const DOCK_MIN = 200;
export const DOCK_MAX = 420;
const DOCK_DEFAULT = 260;

const clampWidth = (w) => Math.min(DOCK_MAX, Math.max(DOCK_MIN, Math.round(w)));

function readWidth() {
  try {
    const n = Number(window.localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(n) && n > 0 ? clampWidth(n) : DOCK_DEFAULT;
  } catch { return DOCK_DEFAULT; }
}

const rowKey = (r) => `${r.windowId ?? 'w'}:${r.tabId}`;

export default function AgentsDock({ onClose }) {
  const { state, actions } = useApp();
  const { focusSession } = actions;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  /* ─── Width: drag the right edge ─── */
  const [width, setWidth] = useState(readWidth);
  const [resizing, setResizing] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;
  const dockRef = useRef(null);
  const stopDrag = useRef(null);
  const startResize = useCallback((e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const left = dockRef.current?.getBoundingClientRect().left ?? 0;
    setResizing(true);
    document.body.classList.add('agents-dock-resizing');
    /* The last width lives here: mouseup can arrive before React has rendered the last move */
    let last = widthRef.current;
    const move = (ev) => { last = clampWidth(ev.clientX - left); setWidth(last); };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('agents-dock-resizing');
      stopDrag.current = null;
      setResizing(false);
      try { window.localStorage.setItem(WIDTH_KEY, String(last)); } catch { /* storage blocked */ }
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    stopDrag.current = up;
  }, []);
  /* Closed mid-drag: no listeners (nor the body class) left behind */
  useEffect(() => () => { stopDrag.current?.(); }, []);
  /* Keyboard: arrows on the focused handle */
  const keyResize = (e) => {
    const step = e.shiftKey ? 40 : 10;
    let next = null;
    if (e.key === 'ArrowLeft') next = width - step;
    else if (e.key === 'ArrowRight') next = width + step;
    if (next === null) return;
    e.preventDefault();
    const w = clampWidth(next);
    setWidth(w);
    try { window.localStorage.setItem(WIDTH_KEY, String(w)); } catch { /* storage blocked */ }
  };

  /* The terminal that has the keyboard here: the focused pane of the active tab */
  const active = state.tabs.find(t => t.id === state.activeTabId);
  const focusId = active && isTerminalTab(active) && !active.hidden ? focusedPaneOf(state, active.id) : null;

  const { windows, rows } = panelSessionRows(state);
  const waiting = rows.filter(isWaiting).length;
  const done = rows.filter(r => r.state === 'done').length;

  /* ─── Right-click menu, inline rename, colour popover ─── */
  const [menu, setMenu] = useState(null);         // { x, y, key }
  const [renaming, setRenaming] = useState(null); // row key
  const [picker, setPicker] = useState(null);     // { key, anchor, el }
  const renamingRef = useRef(null);
  renamingRef.current = renaming;
  const byKey = (key) => rows.find(r => rowKey(r) === key) || null;
  const menuRow = menu ? byKey(menu.key) : null;
  const pickerRow = picker ? byKey(picker.key) : null;
  /* The row went away (closed, moved): its menu/editor/popover go too */
  useEffect(() => { if (menu && !menuRow) setMenu(null); }, [menu, menuRow]);
  useEffect(() => { if (picker && !pickerRow) setPicker(null); }, [picker, pickerRow]);
  useEffect(() => { if (renaming && !byKey(renaming)) setRenaming(null); });
  useEffect(() => {
    if (!menu) return undefined;
    const close = () => setMenu(null);
    const esc = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('click', close);
    document.addEventListener('keydown', esc);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('blur', close);
    };
  }, [menu]);
  const closePicker = useCallback(() => setPicker(null), []);
  const ctx = { state, actions };
  const act = (r, action, value) => runSessionAction(r, action, value, ctx)
    .catch(err => window.alert(`Could not ${action} the session: ${err.message}`));

  const rowEl = (key) => [...(dockRef.current?.querySelectorAll('.agents-dock-row') || [])]
    .find(el => el.dataset.rowKey === key) || null;
  const endRename = (r, text, how) => {
    setRenaming(null);
    if (text !== null) act(r, 'rename', text);
    /* Enter/Esc: the keyboard goes back to the row (the input is gone) */
    if (how === 'key') requestAnimationFrame(() => rowEl(rowKey(r))?.focus({ preventScroll: true }));
  };
  const openColor = (r) => {
    const el = rowEl(rowKey(r));
    if (el) setPicker({ key: rowKey(r), anchor: anchorOf(el), el });
  };

  const open = async (r) => {
    const ok = await focusSession(r);
    if (!ok || r.self === false) return;
    /* The click left the keyboard on this button: hand it to the terminal
       (after the tab switch has painted it). preventScroll: a plain focus()
       scrolls the overflow-hidden wrapper to the textarea and the screen
       shows shifted left. */
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (renamingRef.current) return; /* a rename started meanwhile keeps the keyboard */
      document.querySelector(`[data-pane-id="${CSS.escape(r.tabId)}"] .xterm-helper-textarea`)?.focus({ preventScroll: true });
    }));
  };

  /* Move to New Window: a standalone tab of this window (a pane of a split
     would take its whole tab along) */
  const moveWhy = (r) => {
    if (!FEATURES.multiWindow || r.self === false) return null;
    if (rows.some(o => o.self !== false && o.groupId === r.groupId && o.tabId !== r.tabId)) return 'Move its tab instead (it is split)';
    return cannotMove(state, r.groupId) || '';
  };

  const renderRow = (r) => {
    const current = r.self !== false && r.tabId === focusId;
    const key = rowKey(r);
    const editing = renaming === key;
    const host = r.host || r.title;
    const agent = r.state ? r : null;
    const rowClass = `agents-dock-row${agent ? ` agents-dock-row-${r.state}` : ''}${current ? ' current' : ''}${editing ? ' editing' : ''}`;
    /* The agent state where there is one; else the connection, as on a tab */
    const dot = (
      <span className="agents-dock-dot">
        {agent
          ? <AgentDot agent={agent} showDone idleDot title="" />
          : <span className={`tab-status ${r.connected ? 'connected' : 'disconnected'}`} role="img" aria-label={r.connected ? 'Connected' : 'Disconnected'} />}
      </span>
    );
    /* Under the name: the agent ("Claude Code · Mi Pc" under an alias,
       "Claude Code · working" under the host), else the host under an
       alias, else the kind. The state is also the dot (and the tooltip). */
    const stateLabel = agent ? (AGENT_STATE_LABEL[r.state] || r.state) : '';
    const under = agent
      ? `${r.name} · ${r.alias ? host : stateLabel}`
      : (r.alias ? host : (r.kind === 'local' ? 'Local shell' : 'SSH'));
    const where = (
      <span className="agents-dock-where">
        {r.color && <span className="agents-dock-color" style={{ background: r.color }} aria-hidden="true" />}
        <span className="agents-dock-where-text">{under}</span>
      </span>
    );
    const side = agent && (
      <span className="agents-dock-side">
        <span className="agents-dock-time">{agentElapsed(r.since, now)}</span>
      </span>
    );
    return (
      <li key={key}>
        {editing ? (
          /* Not a button while editing: an input inside one misbehaves */
          <div className={rowClass} data-row-key={key}>
            {dot}
            <span className="agents-dock-main">
              <InlineRename
                className="agents-dock-rename"
                value={r.alias || ''}
                placeholder={host}
                ariaLabel={`Name for this ${host} session`}
                onDone={(text, how) => endRename(r, text, how)}
              />
              {where}
            </span>
            {side}
          </div>
        ) : (
          <button
            className={rowClass}
            data-row-key={key}
            onClick={() => open(r)}
            onContextMenu={(e) => {
              e.preventDefault();
              setPicker(null);
              setMenu({ x: Math.min(e.clientX, window.innerWidth - 200), y: Math.min(e.clientY, window.innerHeight - 190), key });
            }}
            aria-current={current ? 'true' : undefined}
            title={`${r.title}${agent ? ` — ${r.name} · ${stateLabel}` : ''}${r.muted ? ' (muted)' : ''}`}
          >
            {dot}
            <span className="agents-dock-main">
              <span className="agents-dock-name">{r.alias || host}</span>
              {where}
            </span>
            {side}
          </button>
        )}
      </li>
    );
  };

  /* Window by window when there are several (main sends them in order) */
  const groups = [];
  for (const r of rows) {
    const last = groups[groups.length - 1];
    if (last && last.windowNumber === r.windowNumber) last.rows.push(r);
    else groups.push({ windowNumber: r.windowNumber, self: r.self !== false, rows: [r] });
  }

  return (
    <aside
      ref={dockRef}
      className={`agents-dock${resizing ? ' resizing' : ''}`}
      style={{ width, minWidth: width }}
      aria-label="Sessions"
    >
      <div className="agents-dock-head">
        <span className="agents-dock-title">Sessions</span>
        {(waiting > 0 || done > 0) && (
          <span className="agents-dock-summary">
            {waiting > 0 && <span className="agents-dock-waiting">{waiting} waiting</span>}
            {waiting > 0 && done > 0 && ' · '}
            {done > 0 && `${done} done`}
          </span>
        )}
        <button className="agents-dock-close" onClick={onClose} aria-label="Close sessions" title="Close">
          <CloseIcon />
        </button>
      </div>
      {rows.length === 0 ? (
        <div className="agents-dock-empty">No open sessions</div>
      ) : (
        <ul className="agents-dock-list" aria-label="Open sessions">
          {windows > 1 ? groups.map(g => (
            <React.Fragment key={`g${g.windowNumber}`}>
              <li className="agents-dock-group" aria-hidden="true">
                Window {g.windowNumber}{g.self ? ' · this window' : ''}
              </li>
              {g.rows.map(renderRow)}
            </React.Fragment>
          )) : rows.map(renderRow)}
        </ul>
      )}
      {menuRow && (() => {
        const why = moveWhy(menuRow);
        return (
          <div className="tab-context-menu agents-dock-menu" style={{ top: menu.y, left: menu.x }}>
            <button className="tab-context-menu-item" onClick={(e) => { e.stopPropagation(); setMenu(null); setRenaming(menu.key); }}>Rename…</button>
            <button className="tab-context-menu-item" onClick={(e) => { e.stopPropagation(); setMenu(null); openColor(menuRow); }}>Color…</button>
            <button className="tab-context-menu-item" onClick={() => act(menuRow, 'mute', !menuRow.muted)}>
              {menuRow.muted ? 'Unmute Sound' : 'Mute Sound'}
            </button>
            {why !== null && (
              <button className="tab-context-menu-item" disabled={!!why} title={why || undefined}
                onClick={() => actions.moveTabToWindow(menuRow.groupId, 'new').catch(err => window.alert(`Could not move the tab: ${err.message}`))}>
                Move to New Window
              </button>
            )}
            <div className="tab-context-menu-sep" />
            <button className="tab-context-menu-item danger" onClick={() => act(menuRow, 'close')}>Close</button>
          </div>
        );
      })()}
      {pickerRow && (
        <ColorPopover
          anchor={picker.anchor}
          ignoreEl={picker.el}
          value={pickerRow.color}
          title={`This terminal · ${pickerRow.title}`}
          onPick={(hex) => runSessionAction(pickerRow, 'color', hex, ctx)}
          onClose={closePicker}
        />
      )}
      <div
        className="agents-dock-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize agents"
        aria-valuemin={DOCK_MIN}
        aria-valuemax={DOCK_MAX}
        aria-valuenow={width}
        tabIndex={0}
        onMouseDown={startResize}
        onKeyDown={keyResize}
      />
    </aside>
  );
}
