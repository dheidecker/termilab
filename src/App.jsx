import React from 'react';
import { AppProvider, useApp } from './contexts/AppContext';
import Titlebar from './components/Titlebar/Titlebar';
import Sidebar from './components/Sidebar/Sidebar';
import HostList from './components/HostList/HostList';
import HostForm from './components/HostForm/HostForm';
import TabBar from './components/TabBar/TabBar';
import TerminalView from './components/Terminal/TerminalView';
import SFTPExplorer from './components/SFTP/SFTPExplorer';
import Snippets from './components/Snippets/Snippets';
import KeyManager from './components/KeyManager/KeyManager';
import PortForwarding from './components/PortForwarding/PortForwarding';
import Settings from './components/Settings/Settings';
import WelcomeScreen from './components/WelcomeScreen/WelcomeScreen';
import './App.css';

function AppContent() {
  const { state } = useApp();
  const { activeSection, tabs, activeTabId, loading, hostFormOpen } = state;

  if (loading) {
    return (
      <div className="app-loading">
        <div className="app-loading-spinner" />
      </div>
    );
  }

  const activeTab = tabs.find(t => t.id === activeTabId);

  /* Determine which panel to show */
  const renderPanel = () => {
    switch (activeSection) {
      case 'hosts':
        return <HostList />;
      case 'sftp':
        return <HostList sftpMode />;
      case 'snippets':
        return <Snippets />;
      case 'port-forwarding':
        return <PortForwarding />;
      case 'keychain':
        return <KeyManager />;
      case 'settings':
        return <Settings />;
      default:
        return <HostList />;
    }
  };

  /* Determine what to show in the main view area */
  const renderMainView = () => {
    if (!activeTab) return <WelcomeScreen />;

    if (activeTab.type === 'terminal') {
      return <TerminalView key={activeTab.id} tab={activeTab} />;
    }
    if (activeTab.type === 'sftp') {
      return <SFTPExplorer key={activeTab.id} tab={activeTab} />;
    }
    return <WelcomeScreen />;
  };

  /* Render all terminal tabs (keep mounted for persistence) */
  const renderAllTerminals = () => {
    return tabs
      .filter(t => t.type === 'terminal' || t.type === 'local-terminal')
      .map(tab => (
        <div
          key={tab.id}
          style={{ display: tab.id === activeTabId ? 'flex' : 'none', flex: 1, minHeight: 0 }}
        >
          <TerminalView tab={tab} />
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

  const isTerminalType = (type) => type === 'terminal' || type === 'local-terminal' || type === 'sftp';

  const showTabs = tabs.length > 0;
  const showPanel = activeSection !== 'settings';

  return (
    <div className="app">
      <Titlebar />
      <div className="app-body">
        <Sidebar />
        {showPanel && <div className="app-panel">{renderPanel()}</div>}
        <div className="app-main">
          {showTabs && <TabBar />}
          <div className="app-view">
            {tabs.length === 0 && activeSection === 'settings' ? (
              <Settings fullPage />
            ) : tabs.length === 0 ? (
              <WelcomeScreen />
            ) : (
              <>
                {renderAllTerminals()}
                {renderAllSFTP()}
                {activeTab && !isTerminalType(activeTab.type) && (
                  <WelcomeScreen />
                )}
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
    </AppProvider>
  );
}
