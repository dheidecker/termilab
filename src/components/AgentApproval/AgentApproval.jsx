import React, { useEffect, useRef, useState } from 'react';
import { AlertIcon } from '../Icons/icons';
import '../HostKeyPrompt/HostKeyPrompt.css';
import './AgentApproval.css';

/**
 * "An AI agent wants to run a destructive command" (electron/agent/approval.js).
 * Main pauses the agent's call and waits up to 2 minutes for this answer;
 * then it blocks on its own and 'agent:approval-cancel' closes the dialog.
 * One subscriber in the renderer: this component (mounted in App).
 *
 * Block is the default: it has the focus, Escape and closing mean Block.
 * "Run once" lets exactly that command through, that one time.
 */
export function AgentApprovalDialog({ prompt, busy = false, error = null, queued = 0, remainingMs = null, onRun, onBlock }) {
  const blockRef = useRef(null);

  useEffect(() => { blockRef.current?.focus(); }, [prompt.requestId]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onBlock(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onBlock]);

  const who = prompt.client || 'An AI agent';
  const titleId = `aap-title-${prompt.requestId}`;
  const secs = remainingMs === null ? null : Math.max(0, Math.ceil(remainingMs / 1000));
  const left = secs === null ? null : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

  return (
    <div className="hkp-overlay aap-overlay">
      <div className="hkp-modal hkp-changed aap-modal" role="alertdialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="hkp-header">
          <div className="hkp-badge danger"><AlertIcon /></div>
          <div className="hkp-heading">
            <h3 id={titleId}>{who} wants to run a destructive command on <span className="aap-host">{prompt.host}</span></h3>
            <p>It is paused until you decide. Nothing has run yet.</p>
          </div>
        </div>

        <div className="hkp-body">
          <div className="hkp-warning" role="alert">
            <AlertIcon />
            <div>
              <strong>{prompt.label ? prompt.label.charAt(0).toUpperCase() + prompt.label.slice(1) : 'Destructive command'}</strong>
              {prompt.reason && <span>{prompt.reason}</span>}
            </div>
          </div>

          <div className="aap-command-wrap">
            <div className="aap-command-head">
              <span>{prompt.tool === 'send_input' ? 'Typed into the shell' : 'Command'}</span>
              {prompt.cwd && <span className="aap-cwd">in <code>{prompt.cwd}</code></span>}
            </div>
            <pre className="aap-command" tabIndex={0} aria-label="The exact command">{prompt.command}</pre>
          </div>

          {error && <p className="hkp-error">{error}</p>}
          <p className="hkp-dim aap-foot">
            {left !== null && <>Blocked automatically in {left}. </>}
            {queued > 0 && <>{queued} more waiting.</>}
          </p>
        </div>

        <div className="hkp-footer">
          <button ref={blockRef} className="hkp-btn hkp-btn-primary" onClick={onBlock} disabled={busy}>
            Block
          </button>
          <button className="hkp-btn hkp-btn-danger" onClick={onRun} disabled={busy}>
            Run once
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AgentApproval() {
  const [queue, setQueue] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const agents = window.electronAPI?.agents;
    if (!agents || typeof agents.onApprovalPrompt !== 'function') return undefined;
    const onPrompt = agents.onApprovalPrompt((p) => {
      if (!p || typeof p.requestId !== 'string') return;
      /* The deadline is counted from arrival: main's timer started a moment earlier */
      const deadline = Date.now() + (Number(p.timeoutMs) || 120000);
      setNow(Date.now());
      setQueue(q => (q.some(x => x.requestId === p.requestId) ? q : [...q, { ...p, deadline }]));
    });
    const onCancel = agents.onApprovalCancel?.((c) => {
      setQueue(q => q.filter(x => x.requestId !== c?.requestId));
    });
    return () => {
      agents.removeApprovalListener?.(onPrompt);
      agents.removeApprovalListener?.(onCancel);
    };
  }, []);

  const current = queue[0];

  useEffect(() => { setError(null); setBusy(false); }, [current?.requestId]);

  useEffect(() => {
    if (!current) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [current?.requestId]);

  if (!current) return null;

  const answer = async (approve) => {
    if (busy) return;
    setBusy(true);
    try {
      await window.electronAPI.agents.respondApproval(current.requestId, approve);
      setQueue(q => q.filter(x => x.requestId !== current.requestId));
    } catch (err) {
      /* Main already gave up on it (timeout = blocked): drop it */
      if (!approve) setQueue(q => q.filter(x => x.requestId !== current.requestId));
      else setError(err?.message || 'Could not answer');
      setBusy(false);
    }
  };

  return (
    <AgentApprovalDialog
      prompt={current}
      busy={busy}
      error={error}
      queued={queue.length - 1}
      remainingMs={current.deadline - now}
      onRun={() => answer(true)}
      onBlock={() => answer(false)}
    />
  );
}
