import React, { useRef, useState } from 'react';
import { useApp } from '../../contexts/AppContext';
import { ServerIcon, CloseIcon, TerminalIcon } from '../Icons/icons';
import { distroFor, DistroLogo } from '../Icons/distros';
import { hostIconBackground, tabColor } from '../HostList/hostColor';
import { MobileTopBar } from './MobileScreen';
import { sessionTabs, sessionStatus, STATUS_LABEL, closeSessionTab } from './sessions';
import { paneName, cleanAlias } from '../SplitPane/layoutTree';
import './Mobile.css';

const SWIPE_CLOSE_PX = 96;

/* One open session. Swipe left past the threshold (or X) closes it. */
function SessionRow({ tab, host, groupMap, onOpen, onClose }) {
  const [dx, setDx] = useState(0);
  const start = useRef(null);
  const status = sessionStatus(tab);
  const cfg = host || tab.hostConfig || {};
  const distro = distroFor(cfg.os);
  const address = cfg.hostname ? `${cfg.username}@${cfg.hostname}${(Number(cfg.port) || 22) !== 22 ? `:${cfg.port}` : ''}` : '';
  /* A renamed session: its alias is the name, the host goes into the line below */
  const alias = cleanAlias(tab.alias);
  const where = [alias ? tab.label : '', address].filter(Boolean).join(' · ');

  const onTouchStart = (e) => {
    const t = e.touches[0];
    start.current = { x: t.clientX, y: t.clientY, horizontal: null };
  };
  const onTouchMove = (e) => {
    const s = start.current;
    if (!s) return;
    const t = e.touches[0];
    const mx = t.clientX - s.x;
    const my = t.clientY - s.y;
    if (s.horizontal === null && (Math.abs(mx) > 8 || Math.abs(my) > 8)) s.horizontal = Math.abs(mx) > Math.abs(my);
    if (s.horizontal) setDx(Math.min(0, mx));
  };
  const onTouchEnd = async () => {
    const swiped = dx <= -SWIPE_CLOSE_PX;
    start.current = null;
    if (swiped && await onClose()) return;
    setDx(0);
  };

  return (
    <li className="m-session-row-wrap">
      <div className="m-session-row-under" aria-hidden="true">Close</div>
      <div
        className="m-session-row"
        style={dx ? { transform: `translateX(${dx}px)`, transition: 'none' } : undefined}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={() => { start.current = null; setDx(0); }}
      >
        <button className="m-session-open" onClick={onOpen}>
          <span
            className={`hv-icon ${distro ? 'hv-icon-distro' : ''}`}
            style={{ background: hostIconBackground({ ...cfg, color: tabColor(tab, host ? [host] : []) }, distro, groupMap) }}
          >
            {distro ? <DistroLogo os={cfg.os} /> : <ServerIcon />}
          </span>
          <span className="m-session-text">
            <span className="m-session-name">{paneName(tab)}</span>
            <span className="m-session-meta">
              <span className={`m-status-dot m-status-${status}`} aria-hidden="true" />
              {STATUS_LABEL[status]}{where ? ` · ${where}` : ''}
            </span>
          </span>
        </button>
        <button className="m-icon-btn m-session-close" onClick={onClose} aria-label={`Close ${paneName(tab)}`}>
          <CloseIcon />
        </button>
      </div>
    </li>
  );
}

/** Android: the open sessions, in place of the desktop tab strip. */
export default function SessionsScreen() {
  const { state, actions } = useApp();
  const tabs = sessionTabs(state.tabs);
  const groupMap = Object.fromEntries((state.groups || []).map(g => [g.id, g]));

  return (
    <div className="m-screen">
      <MobileTopBar title="Sessions" />
      <div className="m-screen-body">
        {tabs.length === 0 ? (
          <div className="hv-empty">
            <div className="hv-empty-icon"><TerminalIcon /></div>
            <h3>No open sessions</h3>
            <p>Tap a host to connect. Sessions keep running while you use other apps.</p>
            <button className="hv-btn hv-btn-primary" onClick={() => actions.setActiveSection('hosts')}>Go to Hosts</button>
          </div>
        ) : (
          <ul className="m-session-list">
            {tabs.map(tab => (
              <SessionRow
                key={tab.id}
                tab={tab}
                host={state.hosts.find(h => h.id === tab.hostId)}
                groupMap={groupMap}
                onOpen={() => actions.setActiveTab(tab.id)}
                onClose={() => closeSessionTab(tab, actions)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
