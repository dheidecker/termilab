import React from 'react';
import { useApp } from '../../contexts/AppContext';
import {
  VaultIcon, KeyIcon, ForwardIcon, SnippetIcon, FingerprintIcon, ClockIcon, SettingsIcon,
} from '../Icons/icons';
import './Sidebar.css';

/* The home tab's navigation. Only sections that exist; Settings (which also
   holds Sync) is pinned to the bottom. */
const sections = [
  { id: 'hosts', label: 'Hosts', Icon: VaultIcon },
  { id: 'keychain', label: 'Keychain', Icon: KeyIcon },
  { id: 'port-forwarding', label: 'Port Forwarding', Icon: ForwardIcon },
  { id: 'snippets', label: 'Snippets', Icon: SnippetIcon },
  { id: 'known-hosts', label: 'Known Hosts', Icon: FingerprintIcon },
  { id: 'logs', label: 'Logs', Icon: ClockIcon },
];

const settingsItem = { id: 'settings', label: 'Settings', Icon: SettingsIcon };

export default function Sidebar({ collapsed = false }) {
  const { state, actions } = useApp();
  const { setActiveSection } = actions;

  const renderItem = ({ id, label, Icon }) => {
    const active = state.activeSection === id;
    return (
      <button
        key={id}
        className={`sidebar-item ${active ? 'active' : ''}`}
        onClick={() => setActiveSection(id)}
        aria-current={active ? 'page' : undefined}
        aria-label={label}
        title={collapsed ? label : undefined}
      >
        <Icon className="sidebar-item-icon" />
        {!collapsed && <span className="sidebar-item-label">{label}</span>}
      </button>
    );
  };

  return (
    <nav className={`sidebar ${collapsed ? 'collapsed' : ''}`} aria-label="Sections">
      <div className="sidebar-main">{sections.map(renderItem)}</div>
      <div className="sidebar-bottom">{renderItem(settingsItem)}</div>
    </nav>
  );
}
