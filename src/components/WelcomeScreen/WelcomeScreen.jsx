import React from 'react';
import { useApp } from '../../contexts/AppContext';
import './WelcomeScreen.css';

export default function WelcomeScreen() {
  const { state, actions } = useApp();
  const { hosts } = state;

  /* Recent hosts (show up to 5) */
  const recentHosts = hosts.slice(0, 5);

  const handleNewHost = () => actions.openHostForm();

  const handleLocalTerminal = () => {
    const tabId = crypto.randomUUID();
    const sessionId = `local-${tabId}`;
    actions.addTab({
      id: tabId,
      type: 'local-terminal',
      label: 'Local Terminal',
      sessionId,
    });
  };

  const handleImportKey = () => {
    actions.setActiveSection('keychain');
  };

  const handleNewSnippet = () => {
    actions.setActiveSection('snippets');
  };

  const handleConnectRecent = (host) => {
    actions.connectToHost(host);
  };

  return (
    <div className="welcome-screen">
      <div className="welcome-logo">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
      </div>

      <h1 className="welcome-title">Termilab</h1>
      <p className="welcome-subtitle">
        A modern SSH client for managing your servers.
        Connect, explore, and automate — all in one place.
      </p>

      <div className="welcome-actions">
        <button className="welcome-action" onClick={handleLocalTerminal}>
          <div className="welcome-action-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
          </div>
          <span>Local Terminal</span>
        </button>

        <button className="welcome-action" onClick={handleNewHost}>
          <div className="welcome-action-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </div>
          <span>New Host</span>
        </button>

        <button className="welcome-action" onClick={handleImportKey}>
          <div className="welcome-action-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
            </svg>
          </div>
          <span>Import Key</span>
        </button>

        <button className="welcome-action" onClick={handleNewSnippet}>
          <div className="welcome-action-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="16 18 22 12 16 6" />
              <polyline points="8 6 2 12 8 18" />
            </svg>
          </div>
          <span>Snippets</span>
        </button>
      </div>

      {/* Recent connections */}
      {recentHosts.length > 0 && (
        <div className="welcome-recent">
          <div className="welcome-recent-title">Recent Connections</div>
          {recentHosts.map(host => (
            <div
              key={host.id}
              className="welcome-recent-item"
              onClick={() => handleConnectRecent(host)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="7" rx="1.5" />
                <rect x="2" y="14" width="20" height="7" rx="1.5" />
                <circle cx="6" cy="6.5" r="1" fill="currentColor" stroke="none" />
                <circle cx="6" cy="17.5" r="1" fill="currentColor" stroke="none" />
              </svg>
              <span className="welcome-recent-item-label">{host.label}</span>
              <span className="welcome-recent-item-addr">
                {host.username}@{host.hostname}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Keyboard shortcuts */}
      <div className="welcome-shortcuts">
        <div className="welcome-shortcuts-title">Keyboard Shortcuts</div>

        <div className="welcome-shortcut">
          <span className="welcome-shortcut-label">Search in terminal</span>
          <div className="welcome-shortcut-keys">
            <span className="welcome-shortcut-key">Ctrl</span>
            <span className="welcome-shortcut-key">Shift</span>
            <span className="welcome-shortcut-key">F</span>
          </div>
        </div>

        <div className="welcome-shortcut">
          <span className="welcome-shortcut-label">New local terminal</span>
          <div className="welcome-shortcut-keys">
            <span className="welcome-shortcut-key">Ctrl</span>
            <span className="welcome-shortcut-key">`</span>
          </div>
        </div>

        <div className="welcome-shortcut">
          <span className="welcome-shortcut-label">Close tab</span>
          <div className="welcome-shortcut-keys">
            <span className="welcome-shortcut-key">Ctrl</span>
            <span className="welcome-shortcut-key">W</span>
          </div>
        </div>

        <div className="welcome-shortcut">
          <span className="welcome-shortcut-label">Next tab</span>
          <div className="welcome-shortcut-keys">
            <span className="welcome-shortcut-key">Ctrl</span>
            <span className="welcome-shortcut-key">Tab</span>
          </div>
        </div>

        <div className="welcome-shortcut">
          <span className="welcome-shortcut-label">Settings</span>
          <div className="welcome-shortcut-keys">
            <span className="welcome-shortcut-key">Ctrl</span>
            <span className="welcome-shortcut-key">,</span>
          </div>
        </div>
      </div>
    </div>
  );
}
