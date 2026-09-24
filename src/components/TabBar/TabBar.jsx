import React, { useState, useEffect, useCallback } from 'react';
import { useApp } from '../../contexts/AppContext';
import { VaultIcon, ServerIcon, TerminalIcon, FolderIcon, PlusIcon, CloseIcon, BroadcastIcon } from '../Icons/icons';
import { FEATURES } from '../../platform';
import './TabBar.css';
import { useBackHandler } from '../../hooks/useBackHandler';
import { confirmCloseSftp } from '../SFTP/activeTransfers';

function getTabIcon(tab) {
  if (tab.type === 'sftp') return <FolderIcon className="tab-icon" />;
  if (tab.type === 'local-terminal') return <TerminalIcon className="tab-icon" />;
  return <ServerIcon className="tab-icon" />;
}

/**
 * The tab strip, drawn inside the title bar. The first tab is the permanent
 * home tab (Hosts, Keychain, … — whatever the sidebar picks); it is not in
 * `state.tabs` and is active whenever `activeTabId` is null. Session tabs
 * follow, then "+" for a new local terminal.
 */
export default function TabBar() {
  const { state, actions } = useApp();
  const { tabs, activeTabId, broadcast } = state;
  const [contextMenu, setContextMenu] = useState(null);
  useBackHandler(!!contextMenu, () => setContextMenu(null));

  const visibleTabs = tabs.filter(t => !t.hidden);
  const homeActive = !tabs.some(t => t.id === activeTabId);

  /* Close the context menu on outside click */
  useEffect(() => {
    const handler = () => setContextMenu(null);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

  const handleCloseTab = useCallback(async (tabId) => {
    const tab = tabs.find(t => t.id === tabId);
    // Confirm before closing active terminal/SSH sessions
    if (tab?.sessionId && (tab.type === 'local-terminal' || tab.type === 'ssh')) {
      const confirmed = window.confirm(`Close "${tab.label}"? Any running process will be terminated.`);
      if (!confirmed) return;
    }
    if (!confirmCloseSftp(tab)) return;
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

  /* Middle-click to close */
  const handleMouseDown = (e, tabId) => {
    if (e.button === 1) {
      e.preventDefault();
      handleCloseTab(tabId);
    }
  };

  const handleContextMenu = (e, tab) => {
    e.preventDefault();
    setContextMenu({ x: Math.min(e.clientX, window.innerWidth - 170), y: e.clientY, tab });
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
      <div className="tab-bar-tabs" role="tablist">
        <div
          className={`tab tab-home ${homeActive ? 'active' : ''}`}
          role="tab"
          aria-selected={homeActive}
          tabIndex={0}
          onClick={actions.goHome}
          onKeyDown={(e) => { if (e.key === 'Enter') actions.goHome(); }}
        >
          <VaultIcon className="tab-icon" />
          <span className="tab-label">Hosts</span>
        </div>

        {visibleTabs.map(tab => (
          <div
            key={tab.id}
            className={`tab ${tab.id === activeTabId ? 'active' : ''} ${tab.notify ? 'notify' : ''}`}
            role="tab"
            aria-selected={tab.id === activeTabId}
            title={tab.label}
            onClick={() => actions.setActiveTab(tab.id)}
            onMouseDown={(e) => handleMouseDown(e, tab.id)}
            onContextMenu={(e) => handleContextMenu(e, tab)}
          >
            {(tab.type === 'local-terminal' || tab.type === 'ssh') && (
              <span className={`tab-status ${tab.sessionId ? 'connected' : 'disconnected'}`} />
            )}
            {getTabIcon(tab)}
            <span className="tab-label">{tab.label}</span>
            <button
              className="tab-close"
              aria-label={`Close ${tab.label}`}
              onClick={(e) => {
                e.stopPropagation();
                handleCloseTab(tab.id);
              }}
            >
              <CloseIcon />
            </button>
          </div>
        ))}
      </div>

      {FEATURES.localTerminal && (
        <button
          className="tab-add-btn"
          onClick={actions.openLocalTerminal}
          title="New local terminal (Ctrl+T)"
          aria-label="New local terminal"
        >
          <PlusIcon />
        </button>
      )}

      {/* Empty strip: drags the window */}
      <div className="tab-bar-drag" />

      {broadcast && (
        <div className="broadcast-indicator">
          <BroadcastIcon />
          <span>Broadcast</span>
        </div>
      )}
      <button
        className={`broadcast-toggle-btn ${broadcast ? 'active' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          actions.toggleBroadcast();
        }}
        title={broadcast ? 'Disable Broadcast Input' : 'Enable Broadcast Input — type in all tabs at once'}
      >
        <BroadcastIcon />
      </button>

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
