import React, { useEffect, useState } from 'react';
import { AppProvider, useApp } from './contexts/AppContext';
import Titlebar from './components/Titlebar/Titlebar';
import Sidebar from './components/Sidebar/Sidebar';
import HostList from './components/HostList/HostList';
import HostForm from './components/HostForm/HostForm';
import SplitPane from './components/SplitPane/SplitPane';
import SFTPExplorer from './components/SFTP/SFTPExplorer';
import Snippets from './components/Snippets/Snippets';
import KeyManager from './components/KeyManager/KeyManager';
import PortForwarding from './components/PortForwarding/PortForwarding';
import Settings from './components/Settings/Settings';
import KnownHosts from './components/KnownHosts/KnownHosts';
import Logs from './components/Logs/Logs';
import HostKeyPrompt from './components/HostKeyPrompt/HostKeyPrompt';
import UpdateNotification from './components/UpdateNotification/UpdateNotification';
import './App.css';

const SIDEBAR_KEY = 'termilab.sidebar.collapsed';

function readSidebarCollapsed() {
  try { return window.localStorage.getItem(SIDEBAR_KEY) === '1'; } catch { return false; }
}

function AppContent() {
  const { state, actions } = useApp();
  const { activeSection, tabs, activeTabId, loading, hostFormOpen } = state;
  const { openLocalTerminal, setActiveTab, removeTab, disconnectSession } = actions;
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);

  const toggleSidebar = () => {
    setSidebarCollapsed(prev => {
      const next = !prev;
      try { window.localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0'); } catch { /* storage blocked */ }
      return next;
    });
  };

  /* ─── Global Keyboard Shortcuts ─── */
  useEffect(() => {
    const handler = (e) => {
      // Ctrl+T → New local terminal
      if (e.ctrlKey && !e.shiftKey && e.key === 't') {
        e.preventDefault();
        openLocalTerminal();
      }
      // Ctrl+W → Close active tab (the home tab has no id and never closes)
      if (e.ctrlKey && !e.shiftKey && e.key === 'w') {
        e.preventDefault();
        if (activeTabId) {
          const tab = tabs.find(t => t.id === activeTabId);
          if (tab?.sessionId && (tab.type === 'local-terminal' || tab.type === 'ssh')) {
            if (!window.confirm(`Close "${tab.label}"? Any running process will be terminated.`)) return;
          }
          if (tab?.sessionId) {
            if (tab.type === 'local-terminal') {
              window.electronAPI?.localShell?.kill(tab.sessionId).catch(() => {});
            } else {
              disconnectSession(tab.sessionId);
            }
          }
          removeTab(activeTabId);
        }
      }
      // Ctrl+Tab / Ctrl+Shift+Tab → cycle tabs; the home tab (null) comes first
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        const order = [null, ...tabs.filter(t => !t.hidden).map(t => t.id)];
        const current = tabs.some(t => t.id === activeTabId) ? activeTabId : null;
        const idx = order.indexOf(current);
        const step = e.shiftKey ? -1 : 1;
        setActiveTab(order[(idx + step + order.length) % order.length]);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [tabs, activeTabId, openLocalTerminal, setActiveTab, removeTab, disconnectSession]);

  if (loading) {
    return (
      <div className="app-loading">
        <div className="app-loading-spinner" />
      </div>
    );
  }

  /* No session tab selected → the home tab (sidebar + section) is showing */
  const homeActive = !tabs.some(t => t.id === activeTabId);

  const renderSection = () => {
    switch (activeSection) {
      case 'keychain': return <div className="app-section-column"><KeyManager /></div>;
      case 'port-forwarding': return <PortForwarding />;
      case 'snippets': return <div className="app-section-column"><Snippets /></div>;
      case 'known-hosts': return <KnownHosts />;
      case 'logs': return <Logs />;
      case 'settings': return <Settings fullPage />;
      case 'hosts':
      default: return <HostList />;
    }
  };

  /* Session views stay mounted while hidden so terminals keep their state */
  const renderAllTerminals = () => {
    return tabs
      .filter(t => (t.type === 'terminal' || t.type === 'local-terminal') && !t.hidden)
      .map(tab => (
        <div
          key={tab.id}
          style={{ display: tab.id === activeTabId ? 'flex' : 'none', flex: 1, minHeight: 0 }}
        >
          <SplitPane tab={tab} />
        </div>
      ));
  };

  const renderAllSFTP = () => {
    return tabs
      .filter(t => t.type === 'sftp')
      .map(tab => (
        <div
          key={tab.id}
          style={{ display: tab.id === activeTabId ? 'flex' : 'none', flex: 1, minHeight: 0 }}
        >
          <SFTPExplorer tab={tab} />
        </div>
      ));
  };

  return (
    <div className="app">
      <Titlebar sidebarCollapsed={sidebarCollapsed} onToggleSidebar={toggleSidebar} />
      <div className="app-body">
        <div className="app-home" style={{ display: homeActive ? 'flex' : 'none' }}>
          <Sidebar collapsed={sidebarCollapsed} />
          <main className="app-section">{renderSection()}</main>
        </div>
        <div className="app-view" style={{ display: homeActive ? 'none' : 'flex' }}>
          {renderAllTerminals()}
          {renderAllSFTP()}
        </div>
      </div>
      {hostFormOpen && <HostForm />}
      {/* Main asks here when a server's host key is unknown or changed */}
      <HostKeyPrompt />
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <AppContent />
      <UpdateNotification />
    </AppProvider>
  );
}
