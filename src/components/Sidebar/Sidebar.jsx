import React from 'react';
import { useApp } from '../../contexts/AppContext';
import './Sidebar.css';

const sections = [
  {
    id: 'hosts',
    label: 'Hosts',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="3" width="20" height="7" rx="1.5" />
        <rect x="2" y="14" width="20" height="7" rx="1.5" />
        <circle cx="6" cy="6.5" r="1" fill="currentColor" stroke="none" />
        <circle cx="6" cy="17.5" r="1" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
    id: 'sftp',
    label: 'SFTP',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2v11z" />
      </svg>
    ),
  },
  {
    id: 'snippets',
    label: 'Snippets',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="16 18 22 12 16 6" />
        <polyline points="8 6 2 12 8 18" />
      </svg>
    ),
  },
  {
    id: 'port-forwarding',
    label: 'Port Forwarding',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="16 3 21 3 21 8" />
        <line x1="4" y1="20" x2="21" y2="3" />
        <polyline points="21 16 21 21 16 21" />
        <line x1="15" y1="15" x2="21" y2="21" />
        <line x1="4" y1="4" x2="9" y2="9" />
      </svg>
    ),
  },
  {
    id: 'keychain',
    label: 'Keychain',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
      </svg>
    ),
  },
];

const settingsItem = {
  id: 'settings',
  label: 'Settings',
  icon: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
    </svg>
  ),
};

export default function Sidebar() {
  const { state, actions } = useApp();
  const { tabs, activeTabId } = state;

  return (
    <nav className="sidebar">
      <div className="sidebar-main">
        {sections.map((s) => (
          <button
            key={s.id}
            className={`sidebar-btn ${state.activeSection === s.id ? 'active' : ''}`}
            onClick={() => actions.setActiveSection(s.id)}
            aria-label={s.label}
          >
            {s.icon}
            <span className="tooltip">{s.label}</span>
          </button>
        ))}
      </div>
      <div className="sidebar-bottom">
        <button
          className={`sidebar-btn ${tabs.some(t => t.type === 'settings') && activeTabId === tabs.find(t => t.type === 'settings')?.id ? 'active' : ''}`}
          onClick={() => {
            const existing = state.tabs.find(t => t.type === 'settings');
            if (existing) {
              actions.setActiveTab(existing.id);
            } else {
              actions.addTab({ id: 'settings-tab', type: 'settings', label: 'Settings' });
            }
          }}
          aria-label="Settings"
        >
          {settingsItem.icon}
          <span className="tooltip">Settings</span>
        </button>
      </div>
    </nav>
  );
}
