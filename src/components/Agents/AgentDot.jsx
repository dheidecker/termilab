import React from 'react';
import { agentTooltip, AGENT_STATE_LABEL } from '../Terminal/agentRules';
import './Agents.css';

/*
 * An agent's state, small: working = a thin spinning ring in the accent,
 * blocked = an amber dot, done = the green check (only where asked: on a tab
 * the done badge already says it), idle = nothing (or a hollow dot in the
 * Agents panel, `idleDot`, so the rows line up). Tooltip: "Claude Code ·
 * working for 2m".
 */
export default function AgentDot({ agent, showDone = false, idleDot = false, className = '', title }) {
  if (!agent) return null;
  const st = agent.state;
  if (st === 'idle' && !idleDot) return null;
  if (st === 'done' && !showDone) return null;
  const tip = title !== undefined ? title : agentTooltip(agent);
  return (
    <span
      className={`agent-dot agent-dot-${st}${className ? ` ${className}` : ''}`}
      role="img"
      aria-label={`${agent.name}: ${AGENT_STATE_LABEL[st] || st}`}
      title={tip || undefined}
    >
      {st === 'done' && (
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.5 6.3l2.3 2.2 4.7-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      {st === 'blocked' && <span className="agent-dot-q" aria-hidden="true">?</span>}
    </span>
  );
}
