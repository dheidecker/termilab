import React from 'react';
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
    </AppProvider>
  );
}
