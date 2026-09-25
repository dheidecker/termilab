import React, { useEffect, useRef, useState } from 'react';
import { useApp } from '../../../contexts/AppContext';
import { useBackHandler } from '../../../hooks/useBackHandler';
import { ArrowLeftIcon, MoreVerticalIcon, BroadcastIcon } from '../../Icons/icons';
import { closeSessionTab } from '../../Mobile/sessions';
import { tabColor } from '../../HostList/hostColor';
import { solidHeader } from '../../../themes/tint';
import { cleanAlias } from '../../SplitPane/layoutTree';
import InlineRename from '../../SplitPane/InlineRename';

/*
 * The bar on top of a session on Android, in place of the tab strip: back to
 * Hosts, which session this is, and an overflow menu.
 */
export default function SessionHeader({ tab, status, onResetZoom }) {
  const { state, actions } = useApp();
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const menuRef = useRef(null);
  const active = state.activeTabId === tab.id;
  /* The session's colour (its own, or its host's): the whole bar is painted
     in it, text in white or near-black (themes/tint.js), as the desktop pane
     header; the terminal below gets the tinted background */
  const color = tabColor(tab, state.hosts);
  const head = color ? solidHeader(color) : null;
  const alias = cleanAlias(tab.alias);
  useBackHandler(active && menuOpen, () => setMenuOpen(false));
  /* Back while renaming cancels the rename, not the session */
  useBackHandler(active && renaming, () => setRenaming(false));
  useEffect(() => { if (!active && renaming) setRenaming(false); }, [active, renaming]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const close = (e) => { if (!menuRef.current?.contains(e.target)) setMenuOpen(false); };
    document.addEventListener('pointerdown', close, true);
    return () => document.removeEventListener('pointerdown', close, true);
  }, [menuOpen]);

  const goBack = () => { actions.setActiveSection('hosts'); actions.goHome(); };
  const address = tab.hostConfig
    ? `${tab.hostConfig.username}@${tab.hostConfig.hostname}${(Number(tab.hostConfig.port) || 22) !== 22 ? `:${tab.hostConfig.port}` : ''}`
    : '';
  /* Renamed: the alias is the title and the host label joins the line below */
  const sub = [alias ? (tab.label || 'SSH') : '', address].filter(Boolean).join(' · ');

  /* Closing from inside: back to the list of what is still open */
  const closeHere = async () => {
    if (await closeSessionTab(tab, actions)) { actions.setActiveSection('sessions'); actions.goHome(); }
  };

  const run = (fn) => () => { setMenuOpen(false); fn(); };

  return (
    <header
      className={`m-session-header${head ? ' has-color' : ''}`}
      style={head ? { '--pane-color': color, '--pane-head-bg': head.bg, '--pane-head-ink': head.ink } : undefined}
    >
      <button className="m-icon-btn" onClick={goBack} aria-label="Back to hosts">
        <ArrowLeftIcon />
      </button>
      <div className="m-session-title">
        {renaming ? (
          <InlineRename
            className="m-session-rename"
            value={alias}
            placeholder={tab.label || 'SSH'}
            ariaLabel={`Name for this ${tab.label || 'SSH'} session`}
            onDone={(text) => { setRenaming(false); if (text !== null) actions.setTabAlias(tab.id, text); }}
          />
        ) : (
          <span className="m-session-label">
            <span className={`m-status-dot m-status-${status}`} aria-hidden="true" />
            <span className="m-session-label-text">{alias || tab.label || 'SSH'}</span>
          </span>
        )}
        {sub && <span className="m-session-sub">{sub}</span>}
      </div>
      {state.broadcast && (
        <span className="m-broadcast-pill" title="Broadcast input is on">
          <BroadcastIcon /> Broadcast
        </span>
      )}
      <div className="m-menu-anchor" ref={menuRef}>
        <button
          className="m-icon-btn"
          onClick={() => setMenuOpen(o => !o)}
          aria-label="Session menu"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
        >
          <MoreVerticalIcon />
        </button>
        {menuOpen && (
          <div className="m-menu" role="menu">
            <button className="m-menu-item" role="menuitem" onClick={run(() => setRenaming(true))}>
              Rename session
            </button>
            <button className="m-menu-item" role="menuitem" onClick={run(actions.toggleBroadcast)}>
              {state.broadcast ? 'Turn broadcast off' : 'Broadcast input to all sessions'}
            </button>
            <button className="m-menu-item" role="menuitem" onClick={run(onResetZoom)}>
              Reset text size
            </button>
            <button className="m-menu-item m-menu-danger" role="menuitem" onClick={run(closeHere)}>
              Close session
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
