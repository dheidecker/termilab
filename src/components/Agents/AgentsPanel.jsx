import React, { useEffect, useState } from 'react';
import { useApp } from '../../contexts/AppContext';
import { AgentIcon } from '../Icons/icons';
import { agentElapsed, AGENT_STATE_LABEL } from '../Terminal/agentRules';
import { panelAgentRows } from './agentRows';
import AgentDot from './AgentDot';
import './Agents.css';

/*
 * Home → Agents (desktop). Every open terminal, in every window, where an
 * agent CLI was recognised: what it is doing and for how long. Whoever needs
 * the user comes first. A click opens that tab and pane (focusing its window
 * first when it is another one).
 */
export default function AgentsPanel() {
  const { state, actions } = useApp();
  const { focusAgent } = actions;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(id);
  }, []);
  const { windows, rows } = panelAgentRows(state);
  const count = (s) => rows.filter(r => r.state === s).length;
  const summary = [
    count('blocked') && `${count('blocked')} waiting for you`,
    count('done') && `${count('done')} done`,
    count('working') && `${count('working')} working`,
    count('idle') && `${count('idle')} idle`,
  ].filter(Boolean).join(' · ');

  return (
    <div className="hosts-view agents-view">
      <div className="hv-top">
        <div className="hv-actions">
          <h2 className="agents-title">Agents</h2>
          {rows.length > 0 && <span className="agents-summary">{summary}</span>}
        </div>
      </div>
      <div className="hv-scroll">
        {rows.length === 0 ? (
          <div className="hv-empty">
            <div className="hv-empty-icon"><AgentIcon /></div>
            <h3>No agents running</h3>
            <p>
              Start <code>claude</code>, <code>codex</code>, <code>gemini</code>, <code>opencode</code> or{' '}
              <code>aider</code> in any terminal, local or over SSH. Termilab recognises it and shows here
              whether it is working, done, or waiting for your answer.
            </p>
          </div>
        ) : (
          <ul className="agents-list" aria-label="Agents in open terminals">
            {rows.map(r => (
              <li key={`${r.windowId ?? 'w'}:${r.tabId}`}>
                <button
                  className={`agents-row agents-row-${r.state}`}
                  onClick={() => focusAgent(r)}
                  title={`Open ${r.title || r.name}${windows > 1 && !r.self ? ` in window ${r.windowNumber}` : ''}`}
                >
                  <span className="agents-row-dot">
                    <AgentDot agent={r} showDone idleDot title="" />
                  </span>
                  <span className="agents-row-main">
                    <span className="agents-row-name">{r.name}</span>
                    <span className="agents-row-where">
                      {r.color && <span className="agents-row-color" style={{ background: r.color }} aria-hidden="true" />}
                      <span className="agents-row-title">{r.title}</span>
                      {windows > 1 && <span className="agents-row-window">Window {r.windowNumber}</span>}
                    </span>
                  </span>
                  <span className="agents-row-state">
                    <span className="agents-row-label">{AGENT_STATE_LABEL[r.state] || r.state}</span>
                    <span className="agents-row-time">{agentElapsed(r.since, now)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
