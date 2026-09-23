import React, { useState, useEffect } from 'react';
import TabBar from '../TabBar/TabBar';
import { MenuIcon } from '../Icons/icons';
import './Titlebar.css';

const api = () => window.electronAPI;
const hasApi = () => typeof window !== 'undefined' && !!window.electronAPI;

/* On macOS the window keeps its native traffic lights (main.js sets
   titleBarStyle: 'hidden'), so drawing our own controls would show two sets at
   once. We hide ours and leave room on the left for the system's. */
const isMac = typeof window !== 'undefined' && window.electronAPI?.platform === 'darwin';

export default function Titlebar({ sidebarCollapsed = false, onToggleSidebar }) {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (!hasApi() || isMac) return;

    api().window.isMaximized().then(setIsMaximized).catch(() => {});

    /* preload calls this back with the flag as its FIRST argument, not as an
       Electron (event, value) pair. */
    api().window.onMaximizeChange(setIsMaximized);

    return () => api().window.removeMaximizeListener();
  }, []);

  const handleMinimize = () => hasApi() && api().window.minimize();
  const handleMaximize = () => hasApi() && api().window.maximize();
  const handleClose = () => hasApi() && api().window.close();

  return (
    <div className={`titlebar${isMac ? ' titlebar-mac' : ''}`}>
      <div className="titlebar-left">
        <button
          className="titlebar-menu-btn"
          onClick={onToggleSidebar}
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!sidebarCollapsed}
          title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <MenuIcon />
        </button>
      </div>

      {/* Tabs live in the title bar; the empty space after them still drags the window */}
      <TabBar />

      {!isMac && <div className="titlebar-controls">
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
      </div>}
    </div>
  );
}
