import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../../contexts/AppContext';
import { useBackHandler } from '../../hooks/useBackHandler';
import './Keeper.css';

/*
 * The host's sessions the keeper holds on the server (`termilab-keeper
 * list`), over a control connection of its own (no shell). Attach here opens
 * a tab bound to that session; End kills it. Nothing is installed from here:
 * a server without the keeper just says so.
 */
const ago = (unix) => {
  if (!unix) return '—';
  const s = Math.max(0, Math.round(Date.now() / 1000 - unix));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

export default function BackgroundSessions({ host, onClose }) {
  const { actions } = useApp();
  const { openBackgroundSessions, attachBackgroundSession } = actions;
  const [state, setState] = useState({ loading: true, error: null, installed: true, rows: [] });
  const [busy, setBusy] = useState(null);
  /* One control connection per mount; StrictMode mounts twice, so each mount
     has its generation and a late answer from a dead one is dropped */
  const opening = useRef(null);
  const gen = useRef(0);
  const hostRef = useRef(host);
  hostRef.current = host;
  const ref = useRef(null);

  const conn = useCallback(() => {
    if (!opening.current) opening.current = openBackgroundSessions(hostRef.current);
    return opening.current;
  }, [openBackgroundSessions]);

  const load = useCallback(async () => {
    const g = gen.current;
    setState(s => ({ ...s, loading: true, error: null }));
    try {
      const r = await (await conn()).list();
      if (g === gen.current) setState({ loading: false, error: null, installed: r.installed !== false, rows: r.rows || [] });
    } catch (err) {
      if (g === gen.current) setState({ loading: false, error: err?.message || 'Could not list the sessions', installed: true, rows: [] });
    }
  }, [conn]);

  useEffect(() => {
    gen.current++;
    load();
    return () => {
      gen.current++;
      const p = opening.current;
      opening.current = null;
      if (p) p.then(c => c.close(), () => {});
    };
  }, [load, host.id, host.local]);

  useBackHandler(true, onClose);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const end = async (row) => {
    const g = gen.current;
    setBusy(row.id);
    try { await (await conn()).end(row.id); } catch (err) {
      if (g === gen.current) setState(s => ({ ...s, error: err?.message || 'Could not end it' }));
    }
    if (g !== gen.current) return;
    setBusy(null);
    load();
  };
  const attach = (row) => {
    onClose();
    attachBackgroundSession(host, row.id);
  };

  return (
    <div className="keeper-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="keeper-modal keeper-modal-wide" role="dialog" aria-modal="true" aria-labelledby="keeper-bg-title" ref={ref}>
        <div className="keeper-modal-header">
          <h3 id="keeper-bg-title">Background sessions</h3>
          <p>{host.local ? 'This computer — local terminals kept alive in the background' : `${host.label || host.hostname} — sessions kept alive on the server`}</p>
        </div>
        <div className="keeper-modal-body">
          {state.loading && !state.rows.length && <p>Connecting…</p>}
          {state.error && <p className="keeper-error">{state.error}</p>}
          {!state.loading && !state.error && !state.installed && (
            <p>{host.local ? 'No local terminal has been kept alive on this computer yet.' : "Termilab's session keeper is not installed on this server, so nothing runs in the background."}</p>
          )}
          {!state.loading && !state.error && state.installed && !state.rows.length && <p>{host.local ? 'No background sessions on this computer.' : 'No background sessions on this server.'}</p>}
          {state.rows.length > 0 && (
            <ul className="keeper-list">
              {state.rows.map(row => (
                <li key={row.id} className="keeper-row">
                  <div className="keeper-row-main">
                    <div className="keeper-row-title">
                      {row.fgCommand || 'shell'}
                      {row.attached && <span className="keeper-badge">attached</span>}
                    </div>
                    <div className="keeper-row-meta">
                      {row.id} · started {ago(row.created)} · last attached {ago(row.lastAttach)}
                    </div>
                  </div>
                  <button className="keeper-btn keeper-btn-small" onClick={() => attach(row)} disabled={!!busy}
                    title={row.attached ? 'Attaching here detaches it from where it is open now' : undefined}>
                    Attach here
                  </button>
                  <button className="keeper-btn keeper-btn-small keeper-btn-danger" onClick={() => end(row)} disabled={!!busy}>
                    {busy === row.id ? 'Ending…' : 'End'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="keeper-modal-footer">
          <button className="keeper-btn" onClick={load} disabled={state.loading}>Refresh</button>
          <button className="keeper-btn keeper-btn-primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
