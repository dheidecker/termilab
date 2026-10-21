import React, { useCallback, useEffect, useRef, useState } from 'react';
import './PcSwitcher.css';

/*
 * PC switcher (web mirror only): "PC: <this one> ▾" with the other Termilabs
 * of the owner's tailnet (web:peers, electron/web/discovery.js). Picking one
 * navigates the browser to that PC's own mirror; nothing is shared between
 * PCs, each one is independent.
 *
 * Web only: web/entry.jsx stamps data-platform="web" on <html> before the app
 * loads. On desktop and Android this renders nothing.
 */
const isWeb = () => typeof document !== 'undefined' && document.documentElement.dataset.platform === 'web';

const safeUrl = (u) => {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' ? url.href : null;
  } catch (_) {
    return null;
  }
};

export default function PcSwitcher() {
  const [open, setOpen] = useState(false);
  const [peers, setPeers] = useState(null);   // null = not loaded yet
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const rootRef = useRef(null);

  const load = useCallback(() => {
    const api = window.electronAPI && window.electronAPI.web;
    if (!api || typeof api.peers !== 'function') { setError(true); return; }
    setLoading(true);
    setError(false);
    api.peers()
      .then((list) => setPeers(Array.isArray(list) ? list : []))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { if (isWeb()) load(); }, [load]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!isWeb()) return null;

  const self = (peers || []).find(p => p.self);
  const others = (peers || []).filter(p => !p.self);
  const current = (self && self.name) || window.location.hostname.split('.')[0];

  const toggle = () => {
    if (!open) load();   // the list is cached ~60 s in main: cheap
    setOpen(o => !o);
  };
  const go = (peer) => {
    const url = safeUrl(peer.url);
    if (url) window.location.assign(url);
  };

  return (
    <div className="pc-switcher" ref={rootRef}>
      <button
        type="button"
        className="pc-switcher-btn"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Switch to another PC"
      >
        <span className="pc-switcher-label">PC:</span>
        <span className="pc-switcher-name">{current}</span>
        <span className="pc-switcher-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="pc-switcher-menu" role="menu">
          {self && (
            <div className="pc-switcher-item current" role="menuitem" aria-disabled="true" aria-current="true">
              <span className="pc-switcher-item-name">{self.name}</span>
              <span className="pc-switcher-item-meta">this PC</span>
            </div>
          )}
          {others.map(p => (
            <button key={p.dnsName} type="button" className="pc-switcher-item" role="menuitem" onClick={() => go(p)} title={p.dnsName}>
              <span className="pc-switcher-item-name">{p.name}</span>
              {p.version && <span className="pc-switcher-item-meta">v{p.version}</span>}
            </button>
          ))}
          {!others.length && (
            <div className="pc-switcher-empty">
              {loading ? 'Looking for other PCs…' : error ? 'Could not list your PCs.' : 'No other Termilab with Remote access in your tailnet.'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
