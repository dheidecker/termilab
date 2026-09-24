import React from 'react';
import { useApp } from '../../contexts/AppContext';
import { VaultIcon, SnippetIcon, TerminalIcon, MoreHorizontalIcon } from '../Icons/icons';
import { sessionTabs } from './sessions';
import './Mobile.css';

/* Sections reached from More: the bottom nav keeps More lit inside them. */
export const MORE_SECTIONS = ['keychain', 'known-hosts', 'logs', 'settings'];

const ITEMS = [
  { id: 'hosts', label: 'Hosts', Icon: VaultIcon },
  { id: 'snippets', label: 'Snippets', Icon: SnippetIcon },
  { id: 'sessions', label: 'Sessions', Icon: TerminalIcon },
  { id: 'more', label: 'More', Icon: MoreHorizontalIcon },
];

/** Android: the bottom navigation, in place of the desktop sidebar. */
export default function MobileNav() {
  const { state, actions } = useApp();
  const count = sessionTabs(state.tabs).length;
  const current = MORE_SECTIONS.includes(state.activeSection) ? 'more' : state.activeSection;

  return (
    <nav className="m-nav" aria-label="Sections">
      {ITEMS.map(({ id, label, Icon }) => {
        const active = current === id;
        return (
          <button
            key={id}
            className={`m-nav-item${active ? ' active' : ''}`}
            aria-current={active ? 'page' : undefined}
            onClick={() => actions.setActiveSection(id)}
          >
            <span className="m-nav-icon">
              <Icon />
              {id === 'sessions' && count > 0 && (
                <span className="m-badge" aria-label={`${count} open`}>{count > 99 ? '99+' : count}</span>
              )}
            </span>
            <span className="m-nav-label">{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
