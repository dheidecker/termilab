import React from 'react';
import { useApp } from '../../contexts/AppContext';
import { KeyIcon, FingerprintIcon, ClockIcon, SettingsIcon, ChevronRightIcon } from '../Icons/icons';
import { MobileTopBar } from './MobileScreen';
import './Mobile.css';

const ITEMS = [
  { id: 'keychain', label: 'Keychain', sub: 'SSH keys for your hosts', Icon: KeyIcon },
  { id: 'known-hosts', label: 'Known Hosts', sub: 'Server keys this device trusts', Icon: FingerprintIcon },
  { id: 'logs', label: 'Logs', sub: 'When each session started and ended', Icon: ClockIcon },
  { id: 'settings', label: 'Settings', sub: 'Sync, terminal, appearance', Icon: SettingsIcon },
];

/** Android: everything that is not a bottom-nav tab. */
export default function MoreScreen() {
  const { state, actions } = useApp();
  const pending = state.sync?.status?.pendingPairings || 0;
  return (
    <div className="m-screen">
      <MobileTopBar title="More" />
      <div className="m-screen-body">
        <ul className="m-more-list">
          {ITEMS.map(({ id, label, sub, Icon }) => (
            <li key={id}>
              <button className="m-more-item" onClick={() => actions.setActiveSection(id)}>
                <span className="m-more-icon"><Icon /></span>
                <span className="m-more-text">
                  <span className="m-more-label">{label}</span>
                  <span className="m-more-sub">{sub}</span>
                </span>
                {id === 'settings' && pending > 0 && <span className="m-badge m-badge-inline">{pending}</span>}
                <ChevronRightIcon className="m-more-chevron" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
