import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../../contexts/AppContext';
import { CloseIcon } from '../Icons/icons';
import { agentElapsed, AGENT_STATE_LABEL } from '../Terminal/agentRules';
import { isTerminalTab, focusedPaneOf } from '../SplitPane/layoutTree';
import { panelAgentRows } from './agentRows';
import AgentDot from './AgentDot';
import './Agents.css';

/*
 * The Agents dock (desktop): a narrow column next to the sidebar that stays
 * open over whatever is on screen, session tabs included. Every open terminal,
 * in every window, where an agent CLI was recognised; whoever needs the user
 * first. A click focuses that terminal (its window first, when it is another
 * one) and the dock stays. Its width is the user's (drag the right edge).
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

export default function AgentsDock({ onClose }) {
  const { state, actions } = useApp();
  const { focusAgent } = actions;
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

  const { windows, rows } = panelAgentRows(state);
  const count = (s) => rows.filter(r => r.state === s).length;
  const waiting = count('blocked');
  const rest = [
    count('done') && `${count('done')} done`,
    count('working') && `${count('working')} working`,
  ].filter(Boolean).join(' · ');

  const open = async (r) => {
    const ok = await focusAgent(r);
    if (!ok || r.self === false) return;
    /* The click left the keyboard on this button: hand it to the terminal
       (after the tab switch has painted it). preventScroll: a plain focus()
       scrolls the overflow-hidden wrapper to the textarea and the screen
       shows shifted left. */
    requestAnimationFrame(() => requestAnimationFrame(() => {
      document.querySelector(`[data-pane-id="${CSS.escape(r.tabId)}"] .xterm-helper-textarea`)?.focus({ preventScroll: true });
    }));
  };

  return (
    <aside
      ref={dockRef}
      className={`agents-dock${resizing ? ' resizing' : ''}`}
      style={{ width, minWidth: width }}
      aria-label="Agents"
    >
      <div className="agents-dock-head">
        <span className="agents-dock-title">Agents</span>
        {(waiting > 0 || rest) && (
          <span className="agents-dock-summary">
            {waiting > 0 && <span className="agents-dock-waiting">{waiting} waiting</span>}
            {waiting > 0 && rest && ' · '}
            {rest}
          </span>
        )}
        <button className="agents-dock-close" onClick={onClose} aria-label="Close agents" title="Close">
          <CloseIcon />
        </button>
      </div>
      {rows.length === 0 ? (
        <div className="agents-dock-empty">No agents in open terminals</div>
      ) : (
        <ul className="agents-dock-list" aria-label="Agents in open terminals">
          {rows.map(r => {
            const current = r.self !== false && r.tabId === focusId;
            return (
              <li key={`${r.windowId ?? 'w'}:${r.tabId}`}>
                <button
                  className={`agents-dock-row agents-dock-row-${r.state}${current ? ' current' : ''}`}
                  onClick={() => open(r)}
                  aria-current={current ? 'true' : undefined}
                  title={`${r.name} · ${AGENT_STATE_LABEL[r.state] || r.state} — ${r.title}${windows > 1 && !r.self ? ` (window ${r.windowNumber})` : ''}`}
                >
                  <span className="agents-dock-dot">
                    <AgentDot agent={r} showDone idleDot title="" />
                  </span>
                  <span className="agents-dock-main">
                    <span className="agents-dock-name">{r.name}</span>
                    <span className="agents-dock-where">
                      {r.color && <span className="agents-dock-color" style={{ background: r.color }} aria-hidden="true" />}
                      <span className="agents-dock-where-text">{r.title}</span>
                    </span>
                  </span>
                  <span className="agents-dock-side">
                    <span className="agents-dock-time">{agentElapsed(r.since, now)}</span>
                    {windows > 1 && !r.self && <span className="agents-dock-window">W{r.windowNumber}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
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
