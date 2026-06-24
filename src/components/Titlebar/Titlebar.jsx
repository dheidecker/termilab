import React, { useState, useEffect } from 'react';
import './Titlebar.css';

const api = () => window.electronAPI;
const hasApi = () => typeof window !== 'undefined' && !!window.electronAPI;

export default function Titlebar() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (!hasApi()) return;

    api().window.isMaximized().then(setIsMaximized).catch(() => {});

    const cleanup = api().window.onMaximizeChange((_, maximized) => {
      setIsMaximized(maximized);
    });

    return () => {
      if (typeof cleanup === 'function') cleanup();
    };
  }, []);

  const handleMinimize = () => hasApi() && api().window.minimize();
  const handleMaximize = () => hasApi() && api().window.maximize();
  const handleClose = () => hasApi() && api().window.close();

  return (
    <div className="titlebar">
      <div className="titlebar-left">
        <svg className="titlebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
        <span className="titlebar-title">Termilab</span>
      </div>

      <div className="titlebar-center" />

      <div className="titlebar-controls">
        <button className="titlebar-btn" onClick={handleMinimize} aria-label="Minimize">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <button className="titlebar-btn" onClick={handleMaximize} aria-label="Maximize">
          {isMaximized ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="9" y="3" width="12" height="12" rx="1" />
              <path d="M3 9h10v10H4a1 1 0 01-1-1V9z" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="4" y="4" width="16" height="16" rx="2" />
            </svg>
          )}
        </button>
        <button className="titlebar-btn close" onClick={handleClose} aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="6" y1="18" x2="18" y2="6" />
          </svg>
        </button>
      </div>
    </div>
  );
}
