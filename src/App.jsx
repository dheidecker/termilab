import React, { useEffect } from 'react';
import { AppProvider, useApp } from './contexts/AppContext';
import Titlebar from './components/Titlebar/Titlebar';
import Sidebar from './components/Sidebar/Sidebar';
import HostList from './components/HostList/HostList';
import HostForm from './components/HostForm/HostForm';
import TabBar from './components/TabBar/TabBar';
import SplitPane from './components/SplitPane/SplitPane';
import SFTPExplorer from './components/SFTP/SFTPExplorer';
import Snippets from './components/Snippets/Snippets';
import KeyManager from './components/KeyManager/KeyManager';
import PortForwarding from './components/PortForwarding/PortForwarding';
import Settings from './components/Settings/Settings';
import WelcomeScreen from './components/WelcomeScreen/WelcomeScreen';
import UpdateNotification from './components/UpdateNotification/UpdateNotification';
import './App.css';

function AppContent() {
  const { state, actions } = useApp();
  const { activeSection, tabs, activeTabId, loading, hostFormOpen } = state;

  /* ─── Global Keyboard Shortcuts ─── */
  useEffect(() => {
    const handler = (e) => {
      // Ctrl+T → New local terminal
      if (e.ctrlKey && !e.shiftKey && e.key === 't') {
        e.preventDefault();
        const tabId = crypto.randomUUID();
        actions.addTab({
          id: tabId,
          type: 'local-terminal',
          label: 'Local Terminal',
          sessionId: `local-${tabId}`,
        });
      }
      // Ctrl+W → Close active tab
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
              actions.disconnectSession(tab.sessionId);
            }
          }
          actions.removeTab(activeTabId);
        }
      }
      // Ctrl+Tab → Next tab
      if (e.ctrlKey && !e.shiftKey && e.key === 'Tab') {
        e.preventDefault();
        const visible = tabs.filter(t => !t.hidden);
        const idx = visible.findIndex(t => t.id === activeTabId);
        if (visible.length > 0) {
          const next = visible[(idx + 1) % visible.length];
          actions.setActiveTab(next.id);
        }
      }
      // Ctrl+Shift+Tab → Previous tab
      if (e.ctrlKey && e.shiftKey && e.key === 'Tab') {
        e.preventDefault();
        const visible = tabs.filter(t => !t.hidden);
        const idx = visible.findIndex(t => t.id === activeTabId);
        if (visible.length > 0) {
          const prev = visible[(idx - 1 + visible.length) % visible.length];
          actions.setActiveTab(prev.id);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [tabs, activeTabId, actions]);

  if (loading) {
    return (
      <div className="app-loading">
        <div className="app-loading-spinner" />
      </div>
    );
  }

  const activeTab = tabs.find(t => t.id === activeTabId);

  const renderPanel = () => {
    switch (activeSection) {
      case 'hosts': return <HostList />;
      case 'sftp': return <HostList sftpMode />;
      case 'snippets': return <Snippets />;
      case 'port-forwarding': return <PortForwarding />;
      case 'keychain': return <KeyManager />;
      default: return <HostList />;
    }
  };

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

  const isContentTab = (type) => type === 'terminal' || type === 'local-terminal' || type === 'sftp' || type === 'settings';
  const showTabs = tabs.length > 0;

  return (
    <div className="app">
      <Titlebar />
      <div className="app-body">
        <Sidebar />
        <div className="app-panel">{renderPanel()}</div>
        <div className="app-main">
          {showTabs && <TabBar />}
          <div className="app-view">
            {tabs.length === 0 ? (
              <WelcomeScreen />
            ) : (
              <>
                {renderAllTerminals()}
                {renderAllSFTP()}

                {/* Settings tab */}
                {tabs.filter(t => t.type === 'settings').map(tab => (
                  <div
                    key={tab.id}
                    style={{ display: tab.id === activeTabId ? 'flex' : 'none', flex: 1, minHeight: 0 }}
                  >
                    <Settings fullPage />
                  </div>
                ))}

                {activeTab && !isContentTab(activeTab.type) && <WelcomeScreen />}
                {!activeTab && <WelcomeScreen />}
              </>
            )}
          </div>
        </div>
      </div>
      {hostFormOpen && <HostForm />}
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
