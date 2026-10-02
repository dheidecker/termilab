import React, { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import './Keeper.css';

/*
 * Closing a tab whose session the keeper holds on the server, with something
 * other than the shell in the foreground:
 *   [Keep running in background]  → just detach (the default)
 *   [End session]                 → KILL the kept session
 * Escape / backdrop = do not close the tab at all.
 * Mounted on its own root (imperative), so every close path (tab bar, Ctrl+W,
 * pane ×) can await it without owning any state.
 */
function KeeperCloseDialog({ running, onAnswer }) {
  const ref = useRef(null);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onAnswer(null); } };
    window.addEventListener('keydown', onKey, true);
    ref.current?.querySelector('[data-autofocus]')?.focus();
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onAnswer]);
  const commands = [...new Set(running.map(r => r.fgCommand).filter(Boolean))];
  const what = commands.length === 1 ? commands[0] : null;
  /* Only background jobs (`cmd &`, nohup) under an idle shell */
  const where = running.every(r => r.background) ? ' in the background' : '';
  const title = what
    ? `${what} is still running`
    : running.length > 1 ? `${running.length} sessions are still running` : 'The session is still running';
  return (
    <div className="keeper-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onAnswer(null); }}>
      <div className="keeper-modal" role="dialog" aria-modal="true" aria-labelledby="keeper-close-title" ref={ref}>
        <div className="keeper-modal-header">
          <h3 id="keeper-close-title">{what ? <><span className="keeper-cmd">{what}</span> is still running{where}</> : title}</h3>
          <p>{running.map(r => r.label).filter(Boolean).join(', ')}</p>
        </div>
        <div className="keeper-modal-body">
          <p>
            Keep it running on the server and reattach later from the host's
            Background sessions, or end the session and stop {commands.length > 1 ? `${commands.join(', ')}` : 'it'}.
          </p>
        </div>
        <div className="keeper-modal-footer">
          <button className="keeper-btn keeper-btn-danger" onClick={() => onAnswer('end')}>End session</button>
          <button className="keeper-btn keeper-btn-primary" onClick={() => onAnswer('keep')} data-autofocus>Keep running in background</button>
        </div>
      </div>
    </div>
  );
}

/** running: [{label, fgCommand}] → 'keep' | 'end' | null (cancel) */
export function askKeeperClose(running) {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (answer) => {
      root.unmount();
      host.remove();
      resolve(answer);
    };
    root.render(<KeeperCloseDialog running={running} onAnswer={done} />);
  });
}
