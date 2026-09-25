import React, { useEffect, useState } from 'react';
import { AppProvider, useApp } from './contexts/AppContext';
import Titlebar from './components/Titlebar/Titlebar';
import Sidebar from './components/Sidebar/Sidebar';
import HostList from './components/HostList/HostList';
import HostForm from './components/HostForm/HostForm';
import SplitPane from './components/SplitPane/SplitPane';
import SessionStage from './components/SplitPane/SessionStage';
import { memberTabs, groupLabel, isTerminalTab } from './components/SplitPane/layoutTree';
import { confirmCloseSessions, endSessions } from './components/SplitPane/sessions';
import SFTPView from './components/SFTP/SFTPView';
import { confirmCloseSftp } from './components/SFTP/activeTransfers';
import Snippets from './components/Snippets/Snippets';
import KeyManager from './components/KeyManager/KeyManager';
import PortForwarding from './components/PortForwarding/PortForwarding';
import Settings from './components/Settings/Settings';
import KnownHosts from './components/KnownHosts/KnownHosts';
import Logs from './components/Logs/Logs';
import HostKeyPrompt from './components/HostKeyPrompt/HostKeyPrompt';
import UpdateNotification from './components/UpdateNotification/UpdateNotification';
import { FEATURES, IS_ANDROID } from './platform';
import { useBackFallback } from './hooks/useBackHandler';
import MobileNav, { MORE_SECTIONS } from './components/Mobile/MobileNav';
import MobileScreen, { MobileTopBar } from './components/Mobile/MobileScreen';
import SessionsScreen from './components/Mobile/SessionsScreen';
import MoreScreen from './components/Mobile/MoreScreen';
import './App.css';

const SIDEBAR_KEY = 'termilab.sidebar.collapsed';

/* On a phone the full-width sidebar eats half the screen: start collapsed
   there unless the user expanded it before. Desktop default unchanged. */
function readSidebarCollapsed() {
  try {
    const saved = window.localStorage.getItem(SIDEBAR_KEY);
    return saved === null ? IS_ANDROID : saved === '1';
  } catch { return IS_ANDROID; }
}

function AppContent() {
  const { state, actions } = useApp();
  const { activeSection, tabs, activeTabId, loading, hostFormOpen } = state;
  const { openLocalTerminal, setActiveTab, removeTab, disconnectSession, goHome, setActiveSection } = actions;
  const { layouts } = state;
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);

  /* No session tab selected → the home tab (sidebar + section) is showing */
  const homeActive = !tabs.some(t => t.id === activeTabId);

  const toggleSidebar = () => {
    setSidebarCollapsed(prev => {
      const next = !prev;
      try { window.localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0'); } catch { /* storage blocked */ }
      return next;
    });
  };

  /* Android back, once nothing dismissable is open (modals register their own
     handlers in useBackHandler): a page under More → More, session tab →
     Hosts, any other section → Hosts. At Hosts it passes, and the app goes to
     the background (moveTaskToBack, not finish: sessions stay up). */
  useBackFallback(() => {
    /* Android has no sidebar: a More page goes back to More, then Hosts */
    if (IS_ANDROID && homeActive && MORE_SECTIONS.includes(activeSection)) { setActiveSection('more'); return true; }
    if (!homeActive) { setActiveSection('hosts'); goHome(); return true; }
    if (activeSection !== 'hosts') { setActiveSection('hosts'); return true; }
    return false;
  });

  /* ─── Global Keyboard Shortcuts ─── */
  useEffect(() => {
    const handler = (e) => {
      // Ctrl+T → New local terminal
      if (e.ctrlKey && !e.shiftKey && e.key === 't' && FEATURES.localTerminal) {
        e.preventDefault();
        openLocalTerminal();
      }
      // Ctrl+W → Close active tab (the home tab has no id and never closes)
      if (e.ctrlKey && !e.shiftKey && e.key === 'w') {
        e.preventDefault();
        if (activeTabId) {
          const tab = tabs.find(t => t.id === activeTabId);
          /* A split tab closes all its panes, like its × in the tab bar */
          const members = isTerminalTab(tab) ? memberTabs({ tabs, layouts }, activeTabId) : (tab ? [tab] : []);
          if (!confirmCloseSessions(members, groupLabel(members).label)) return;
          if (!confirmCloseSftp(tab)) return;
          endSessions(members, disconnectSession);
          removeTab(members.map(t => t.id));
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
  }, [tabs, layouts, activeTabId, openLocalTerminal, setActiveTab, removeTab, disconnectSession]);

  if (loading) {
    return (
      <div className="app-loading">
        <div className="app-loading-spinner" />
      </div>
    );
  }

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

  /* Android: bottom-nav screens, and the More pages with a back bar */
  const backToMore = () => setActiveSection('more');
  const renderMobileSection = () => {
    switch (activeSection) {
      case 'snippets':
        return (
          <div className="m-screen">
            <MobileTopBar title="Snippets" />
            <div className="m-screen-body"><div className="app-section-column"><Snippets /></div></div>
          </div>
        );
      case 'sessions': return <SessionsScreen />;
      case 'more': return <MoreScreen />;
      case 'keychain': return <MobileScreen title="Keychain" onBack={backToMore}><div className="app-section-column"><KeyManager /></div></MobileScreen>;
      case 'known-hosts': return <MobileScreen title="Known Hosts" onBack={backToMore}><KnownHosts /></MobileScreen>;
      case 'logs': return <MobileScreen title="Logs" onBack={backToMore}><Logs /></MobileScreen>;
      case 'settings': return <div className="m-screen"><Settings fullPage onBack={backToMore} /></div>;
      case 'hosts':
      default: return <HostList />;
    }
  };

  /* Android: session views stay mounted while hidden so terminals keep their
     state. Desktop uses SessionStage (split panes that move between tabs). */
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
          <SFTPView tab={tab} />
        </div>
      ));
  };

  if (IS_ANDROID) {
    return (
      <div className={`app app-mobile${homeActive ? ' app-mobile-home' : ' app-mobile-session'}`}>
        <div className="app-body">
          <div className="app-home" style={{ display: homeActive ? 'flex' : 'none' }}>
            <main className="app-section">{renderMobileSection()}</main>
          </div>
          <div className="app-view" style={{ display: homeActive ? 'none' : 'flex' }}>
            {renderAllTerminals()}
          </div>
        </div>
        {homeActive && <MobileNav />}
        {hostFormOpen && <HostForm />}
        <HostKeyPrompt />
      </div>
    );
  }

  return (
    <div className="app">
      <Titlebar sidebarCollapsed={sidebarCollapsed} onToggleSidebar={toggleSidebar} />
      <div className="app-body">
        <div className="app-home" style={{ display: homeActive ? 'flex' : 'none' }}>
          <Sidebar collapsed={sidebarCollapsed} />
          <main className="app-section">{renderSection()}</main>
        </div>
        <div className="app-view" style={{ display: homeActive ? 'none' : 'flex' }}>
          <SessionStage />
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
