import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useApp } from '../../contexts/AppContext';
import './TabBar.css';

/* Tab type icons */
const TerminalIcon = () => (
  <svg className="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="4 17 10 11 4 5" />
    <line x1="12" y1="19" x2="20" y2="19" />
  </svg>
);

const SSHIcon = () => (
  <svg className="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="3" width="20" height="7" rx="1.5" />
    <rect x="2" y="14" width="20" height="7" rx="1.5" />
    <circle cx="6" cy="6.5" r="1" fill="currentColor" stroke="none" />
    <circle cx="6" cy="17.5" r="1" fill="currentColor" stroke="none" />
  </svg>
);

const SFTPIcon = () => (
  <svg className="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2v11z" />
  </svg>
);

function getTabIcon(tab) {
  if (tab.type === 'sftp') return <SFTPIcon />;
  if (tab.type === 'local-terminal') return <TerminalIcon />;
  if (tab.type === 'settings') return (
    <svg className="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/>
    </svg>
  );
  return <SSHIcon />;
}

export default function TabBar() {
  const { state, actions } = useApp();
  const { tabs, activeTabId } = state;
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [contextMenu, setContextMenu] = useState(null);
  const addRef = useRef(null);

  /* Close menus on outside click */
  useEffect(() => {
    const handler = (e) => {
      setContextMenu(null);
      if (addRef.current && !addRef.current.contains(e.target)) {
        setShowAddMenu(false);
      }
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

  /* Middle-click to close */
  const handleMouseDown = (e, tabId) => {
    if (e.button === 1) {
      e.preventDefault();
      handleCloseTab(tabId);
    }
  };

  const handleCloseTab = useCallback(async (tabId) => {
    const tab = tabs.find(t => t.id === tabId);
    if (tab?.sessionId) {
      if (tab.type === 'local-terminal') {
        try {
          await window.electronAPI?.localShell?.kill(tab.sessionId);
        } catch (e) { /* ignore - session might already be closed */ }
      } else {
        await actions.disconnectSession(tab.sessionId);
      }
    }
    actions.removeTab(tabId);
  }, [tabs, actions]);

  const handleContextMenu = (e, tab) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, tab });
  };

  const openLocalTerminal = () => {
    const tabId = crypto.randomUUID();
    const sessionId = `local-${tabId}`;
    actions.addTab({
      id: tabId,
      type: 'local-terminal',
      label: 'Local Terminal',
      sessionId,
    });
    setShowAddMenu(false);
  };

  const closeOtherTabs = () => {
    if (!contextMenu) return;
    tabs.forEach(t => {
      if (t.id !== contextMenu.tab.id) {
        handleCloseTab(t.id);
      }
    });
  };

  return (
    <div className="tab-bar">
      <div className="tab-bar-tabs">
        {tabs.filter(t => !t.hidden).map(tab => (
          <div
            key={tab.id}
            className={`tab ${tab.id === activeTabId ? 'active' : ''}`}
            onClick={() => actions.setActiveTab(tab.id)}
            onMouseDown={(e) => handleMouseDown(e, tab.id)}
            onContextMenu={(e) => handleContextMenu(e, tab)}
          >
            {getTabIcon(tab)}
            <span className="tab-label">{tab.label}</span>
            <button
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                handleCloseTab(tab.id);
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="6" y1="6" x2="18" y2="18" />
                <line x1="6" y1="18" x2="18" y2="6" />
              </svg>
            </button>
          </div>
        ))}
      </div>

      <div className="tab-bar-add" ref={addRef}>
        <button
          className="tab-add-btn"
          onClick={(e) => {
            e.stopPropagation();
            setShowAddMenu(!showAddMenu);
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>

        {showAddMenu && (
          <div className="tab-add-dropdown">
            <button className="tab-add-dropdown-item" onClick={openLocalTerminal}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" y1="19" x2="20" y2="19" />
              </svg>
              New Local Terminal
            </button>
            <button
              className="tab-add-dropdown-item"
              onClick={() => {
                actions.setActiveSection('hosts');
                actions.openHostForm(null);
                setShowAddMenu(false);
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="7" rx="1.5" />
                <rect x="2" y="14" width="20" height="7" rx="1.5" />
                <circle cx="6" cy="6.5" r="1" fill="currentColor" stroke="none" />
                <circle cx="6" cy="17.5" r="1" fill="currentColor" stroke="none" />
              </svg>
              New Host Connection
            </button>
          </div>
        )}
      </div>

      {/* Tab context menu */}
      {contextMenu && (
        <div
          className="tab-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <button className="tab-context-menu-item" onClick={() => handleCloseTab(contextMenu.tab.id)}>
            Close
          </button>
          <button className="tab-context-menu-item" onClick={closeOtherTabs}>
            Close Others
          </button>
          <button
            className="tab-context-menu-item danger"
            onClick={() => tabs.forEach(t => handleCloseTab(t.id))}
          >
            Close All
          </button>
        </div>
      )}
    </div>
  );
}
