import React from 'react';
import { useApp } from '../../contexts/AppContext';
import {
  VaultIcon, KeyIcon, ForwardIcon, SnippetIcon, FingerprintIcon, ClockIcon, SettingsIcon, FolderIcon, AgentIcon,
} from '../Icons/icons';
import { FEATURES, IS_ANDROID } from '../../platform';
import { panelAgentRows } from '../Agents/agentRows';
import './Sidebar.css';
import '../Agents/Agents.css';

/* The home tab's navigation. Only sections that exist; Settings (which also
   holds Sync) is pinned to the bottom. SFTP is not a section: it opens (or
   returns to) an SFTP tab in the tab strip, like Termius. */
const sections = [
  { id: 'hosts', label: 'Hosts', Icon: VaultIcon },
  { id: 'sftp', label: 'SFTP', Icon: FolderIcon, available: FEATURES.sftp, opensTab: true },
  /* Not a section: toggles the Agents dock, which stays open over any view
     (Android: the Sessions screen shows them) */
  { id: 'agents', label: 'Agents', Icon: AgentIcon, available: !IS_ANDROID, toggle: true },
  { id: 'keychain', label: 'Keychain', Icon: KeyIcon },
  { id: 'port-forwarding', label: 'Port Forwarding', Icon: ForwardIcon, available: FEATURES.portForwarding },
  { id: 'snippets', label: 'Snippets', Icon: SnippetIcon },
  { id: 'known-hosts', label: 'Known Hosts', Icon: FingerprintIcon },
  { id: 'logs', label: 'Logs', Icon: ClockIcon },
].filter(s => s.available !== false);

const settingsItem = { id: 'settings', label: 'Settings', Icon: SettingsIcon };

export default function Sidebar({ collapsed = false, onNavigate, agentsOpen = false, onToggleAgents }) {
  const { state, actions } = useApp();
  const { setActiveSection, openSFTP, goHome } = actions;
  /* Over a session tab no section is on screen: nothing is highlighted, and
     picking one goes back to the home tab with it */
  const homeActive = !state.tabs.some(t => t.id === state.activeTabId);
  /* Agents waiting for the user, in any window */
  const waiting = panelAgentRows(state).rows.filter(r => r.state === 'blocked').length;

  const renderItem = ({ id, label, Icon, opensTab, toggle }) => {
    const active = homeActive && !opensTab && !toggle && state.activeSection === id;
    const toggled = toggle && agentsOpen;
    return (
      <button
        key={id}
        className={`sidebar-item ${active ? 'active' : ''}${toggled ? ' toggled' : ''}`}
        onClick={() => {
          if (toggle) { onToggleAgents?.(); return; }
          if (opensTab) openSFTP();
          else { setActiveSection(id); if (!homeActive) goHome(); }
          onNavigate?.();
        }}
        aria-current={active ? 'page' : undefined}
        aria-pressed={toggle ? agentsOpen : undefined}
        aria-label={label}
        title={collapsed ? label : undefined}
      >
        <Icon className="sidebar-item-icon" />
        {!collapsed && <span className="sidebar-item-label">{label}</span>}
        {id === 'agents' && waiting > 0 && (
          <span className="sidebar-badge" title={`${waiting} waiting for your input`}>{waiting}</span>
        )}
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
