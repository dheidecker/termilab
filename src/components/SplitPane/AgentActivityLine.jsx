import React, { useEffect, useRef, useState } from 'react';

/*
  The agent CLI's state on the pane's top edge (Settings → Terminal → Show
  agent activity on panes). Reads tab.agent, which TerminalView's scan
  already publishes (agentRules.js tracker, AGENT_STATE): no detector here.

    working  a 2px accent segment running edge to edge (indeterminate bar)
    blocked  the whole edge amber, pulsing slowly (permission / question)
    done     a green flash of ~1.2 s that fades out, then nothing
    idle / no agent: nothing

  Hysteresis: "working" and "nothing" switch only after the new state held
  for HOLD_MS (both ways), so a short burst of output or a scan that briefly
  misses the spinner does not flicker the line. "Needs you" and "finished"
  are events and show at once. Animations are CSS on transform / opacity
  only (SplitPane.css); prefers-reduced-motion gets static lines.
*/
export const HOLD_MS = 400;
/* A "done" older than this (a tab restored or moved in) is not flashed */
const DONE_FRESH_MS = 2500;

const shown = (agent) => {
  const s = agent && agent.state;
  if (s === 'working') return 'working';
  if (s === 'blocked') return 'waiting';
  if (s === 'done') return 'done';
  return null;
};

/** The shown state ('working' | 'waiting' | 'done' | null) with its hysteresis;
    shared by the edge line (no header) and the pane header's sweep. */
export function useAgentActivity(agent) {
  const target = shown(agent);
  const since = agent ? agent.since : 0;
  const [view, setView] = useState(() => (target === 'done' ? null : target));
  const [flashKey, setFlashKey] = useState(0);
  const timer = useRef(null);

  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = null;
    if (target === 'done') {
      if (Date.now() - (since || 0) < DONE_FRESH_MS) {
        setFlashKey(since || Date.now());
        setView('done');
      } else {
        setView(null);
      }
      return undefined;
    }
    if (target === 'waiting') { setView('waiting'); return undefined; }
    /* working <-> nothing: only once it held */
    timer.current = setTimeout(() => { timer.current = null; setView(target); }, HOLD_MS);
    return () => { clearTimeout(timer.current); timer.current = null; };
  }, [target, since]);

  /* The flash removes itself; the timer is the backstop for a missed animationend */
  useEffect(() => {
    if (view !== 'done') return undefined;
    const t = setTimeout(() => setView(v => (v === 'done' ? null : v)), 1400);
    return () => clearTimeout(t);
  }, [view, flashKey]);

  const end = () => setView(v => (v === 'done' ? null : v));
  return { view, flashKey, end };
}

export default function AgentActivityLine({ agent }) {
  const { view, flashKey, end } = useAgentActivity(agent);
  if (!view) return null;
  return (
    <div
      key={view === 'done' ? `done-${flashKey}` : view}
      className={`pane-agent-line ${view}`}
      data-agent-line={view}
      aria-hidden="true"
      onAnimationEnd={view === 'done' ? end : undefined}
    >
      {view === 'working' && <span className="pane-agent-line-bar" />}
    </div>
  );
}

/* The same states over a pane's title bar: a light sweeping across it while
   the agent works, an amber pulse while it waits, a green flash when done.
   Much easier to see than the 2px line, which is kept for panes with no header. */
export function PaneHeaderActivity({ agent }) {
  const { view, flashKey, end } = useAgentActivity(agent);
  if (!view) return null;
  return (
    <div
      key={view === 'done' ? `done-${flashKey}` : view}
      className={`pane-header-activity ${view}`}
      data-agent-line={view}
      aria-hidden="true"
      onAnimationEnd={view === 'done' ? end : undefined}
    />
  );
}
