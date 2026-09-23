import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../contexts/AppContext';
import {
  ForwardIcon, SearchIcon, CloseIcon, ChevronDownIcon, PlusIcon, PencilIcon, CopyIcon, TrashIcon,
  PlayIcon, StopIcon,
} from '../Icons/icons';
import ViewOptions, { useViewChoice, useSortChoice, sortItems } from '../ViewOptions/ViewOptions';
import PortForwardDrawer from './PortForwardDrawer';
import { TYPES, TYPE_INFO, routeSummary } from './rules';
import '../HostList/HostList.css';
import '../HostForm/HostForm.css';
import './PortForwarding.css';

/**
 * Home tab → Port Forwarding. A card per rule with its live state, a toggle to
 * start/stop it, and the drawer to create (wizard) or edit it.
 *
 * Running state comes from main (state.portForwardStatus, keyed by rule id)
 * and is never saved with the rule. Starting sends only the rule id: main
 * reads the host and its credentials itself.
 */

const STATE_TEXT = { running: 'Running', starting: 'Starting…', error: 'Error', stopped: 'Stopped' };

function StatusDot({ state, error }) {
  const text = state === 'error' && error ? `Error: ${error}` : STATE_TEXT[state];
  return <span className={`pf-dot pf-dot-${state}`} role="img" aria-label={text} title={text} />;
}

export default function PortForwarding() {
  const { state, actions } = useApp();
  const { portForwards, hosts, groups, portForwardStatus } = state;
  const { savePortForward, deletePortForward, startPortForward, stopPortForward } = actions;

  const [view, setView] = useViewChoice('termilab.portforwards.view');
  const [sort, setSort] = useSortChoice('termilab.portforwards.sort');
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [drawer, setDrawer] = useState(null);   // { ruleId } | { newType }
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState(null);
  const searchRef = useRef(null);
  const newMenuRef = useRef(null);

  const hostMap = useMemo(() => Object.fromEntries(hosts.map(h => [h.id, h])), [hosts]);
  const groupMap = useMemo(() => Object.fromEntries((groups || []).map(g => [g.id, g])), [groups]);

  useEffect(() => { if (searchOpen) searchRef.current?.focus(); }, [searchOpen]);

  useEffect(() => {
    if (!contextMenu && !newMenuOpen) return undefined;
    const close = (e) => {
      if (newMenuRef.current && newMenuRef.current.contains(e.target)) return;
      setContextMenu(null);
      setNewMenuOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') { setContextMenu(null); setNewMenuOpen(false); } };
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [contextMenu, newMenuOpen]);

  const statusOf = (id) => portForwardStatus[id] || { state: 'stopped' };
  const hostOf = (rule) => (rule.hostId ? hostMap[rule.hostId] || null : null);
  const hostText = (rule) => {
    if (!rule.hostId) return 'Choose a host';
    const h = hostMap[rule.hostId];
    return h ? h.label || h.hostname : 'Host deleted';
  };

  const q = search.trim().toLowerCase();
  const visible = sortItems(
    portForwards.filter(r => !q || [r.label, hostText(r), routeSummary(r), TYPE_INFO[r.type]?.label]
      .some(v => String(v || '').toLowerCase().includes(q))),
    sort,
    { label: r => r.label, date: r => r.createdAt }
  );

  const openNew = (type = 'local') => { setNewMenuOpen(false); setDrawer({ newType: type }); };
  const openEdit = (rule) => setDrawer({ ruleId: rule.id });
  const editing = drawer?.ruleId ? portForwards.find(r => r.id === drawer.ruleId) : null;

  const toggle = (rule) => {
    const st = statusOf(rule.id).state;
    if (st === 'running' || st === 'starting') stopPortForward(rule.id);
    else if (!hostOf(rule)) openEdit(rule);   // nothing to start through yet
    else startPortForward(rule.id);
  };

  const handleDelete = (rule) => {
    const st = statusOf(rule.id).state;
    const extra = st === 'running' || st === 'starting' ? ' It is running and will be stopped.' : '';
    if (window.confirm(`Delete the port forwarding rule “${rule.label}”?${extra}`)) deletePortForward(rule.id);
  };

  const handleContextMenu = (e, rule) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: Math.min(e.clientX, window.innerWidth - 200), y: Math.min(e.clientY, window.innerHeight - 200), rule });
  };

  const renderCard = (rule) => {
    const { state: st, error } = statusOf(rule.id);
    const active = st === 'running' || st === 'starting';
    const host = hostOf(rule);
    const info = TYPE_INFO[rule.type] || TYPE_INFO.local;
    const toggleLabel = active ? `Stop ${rule.label}` : host ? `Start ${rule.label}` : `Choose a host for ${rule.label}`;
    return (
      <div
        key={rule.id}
        className={`hv-card pf-card pf-state-${st}`}
        role="button"
        tabIndex={0}
        onClick={() => openEdit(rule)}
        onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) openEdit(rule); }}
        onContextMenu={(e) => handleContextMenu(e, rule)}
      >
        <div className={`hv-icon pf-letter pf-letter-${rule.type}`} aria-label={`${info.label} forwarding`} title={`${info.label} forwarding`}>
          {info.letter}
        </div>
        <div className="hv-card-text">
          <div className="hv-card-label">{rule.label}</div>
          <div className="hv-card-sub">
            <span className={host ? '' : 'pf-need-host'}>{hostText(rule)}</span>
            <span className="pf-sep"> · </span>
            <span className="pf-route">{routeSummary(rule)}</span>
          </div>
          {st === 'error' && error && <div className="pf-card-error" title={error}>{error}</div>}
        </div>
        <StatusDot state={st} error={error} />
        <button
          className={`pf-toggle ${active ? 'active' : ''}`}
          onClick={(e) => { e.stopPropagation(); toggle(rule); }}
          aria-label={toggleLabel}
          title={active ? 'Stop' : host ? 'Start' : 'Choose a host first'}
        >
          {active ? <StopIcon /> : <PlayIcon />}
        </button>
      </div>
    );
  };

  return (
    <div className="hosts-view pf-view">
      <div className="hv-top">
        <div className="hv-actions">
          <div className="hv-split" ref={newMenuRef}>
            <button className="hv-btn hv-btn-primary hv-split-main" onClick={() => openNew('local')}>
              <ForwardIcon />
              New forwarding
            </button>
            <button
              className="hv-btn hv-btn-primary hv-split-toggle"
              aria-label="Choose the forwarding type"
              aria-haspopup="menu"
              aria-expanded={newMenuOpen}
              onClick={() => setNewMenuOpen(o => !o)}
            >
              <ChevronDownIcon />
            </button>
            {newMenuOpen && (
              <div className="hv-menu hv-split-menu" role="menu">
                {TYPES.map(t => (
                  <button key={t} role="menuitem" className="hv-menu-item" onClick={() => openNew(t)}>
                    <span className={`pf-letter pf-letter-sm pf-letter-${t}`} aria-hidden="true">{TYPE_INFO[t].letter}</span>
                    {TYPE_INFO[t].label} forwarding
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="hv-actions-spacer" />

          {searchOpen ? (
            <div className="hv-search kh-search pf-search">
              <SearchIcon className="hv-search-icon" />
              <input
                ref={searchRef}
                type="text"
                placeholder="Filter port forwarding…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape') { setSearch(''); setSearchOpen(false); } }}
                spellCheck={false}
                aria-label="Filter port forwarding rules"
              />
              <button className="hv-search-clear" onClick={() => { setSearch(''); setSearchOpen(false); }} aria-label="Close search">
                <CloseIcon />
              </button>
            </div>
          ) : (
            <button className="vo-btn" onClick={() => setSearchOpen(true)} aria-label="Search port forwarding" title="Search">
              <SearchIcon />
            </button>
          )}
          <ViewOptions view={view} onViewChange={setView} sort={sort} onSortChange={setSort} />
        </div>
      </div>

      <div className="hv-scroll">
        {portForwards.length === 0 ? (
          <div className="hv-empty">
            <div className="hv-empty-icon"><ForwardIcon /></div>
            <h3>No port forwarding rules yet</h3>
            <p>Reach a port on a server as if it were on this computer, share a local port through a server, or browse through it with a SOCKS5 proxy.</p>
            <button className="hv-btn hv-btn-primary" onClick={() => openNew('local')}>
              <PlusIcon /> New forwarding
            </button>
          </div>
        ) : visible.length === 0 ? (
          <div className="hv-empty">
            <div className="hv-empty-icon"><SearchIcon /></div>
            <h3>No rules match “{search.trim()}”</h3>
            <p>Try a label, a host or a port.</p>
          </div>
        ) : (
          <section className="hv-section">
            <h4 className="hv-section-title">Port Forwarding</h4>
            <div className={`hv-grid ${view === 'list' ? 'hv-list' : ''}`}>
              {visible.map(renderCard)}
            </div>
          </section>
        )}
      </div>

      {contextMenu && (() => {
        const rule = contextMenu.rule;
        const st = statusOf(rule.id).state;
        const active = st === 'running' || st === 'starting';
        return (
          <div className="host-context-menu" style={{ top: contextMenu.y, left: contextMenu.x }} onContextMenu={(e) => e.preventDefault()}>
            <button className="host-context-menu-item" onClick={() => toggle(rule)}>
              {active ? <><StopIcon /> Stop</> : hostOf(rule) ? <><PlayIcon /> Start</> : <><PencilIcon /> Choose a host</>}
            </button>
            <div className="host-context-separator" />
            <button className="host-context-menu-item" onClick={() => openEdit(rule)}>
              <PencilIcon /> Edit
            </button>
            <button
              className="host-context-menu-item"
              onClick={() => {
                // eslint-disable-next-line no-unused-vars
                const { id, createdAt, updatedAt, ...copy } = rule;
                savePortForward({ ...copy, label: `${rule.label} (copy)` });
              }}
            >
              <CopyIcon /> Duplicate
            </button>
            <div className="host-context-separator" />
            <button className="host-context-menu-item danger" onClick={() => handleDelete(rule)}>
              <TrashIcon /> Delete
            </button>
          </div>
        );
      })()}

      {drawer && (drawer.newType || editing) && (
        <PortForwardDrawer
          key={drawer.ruleId || `new-${drawer.newType}`}
          rule={editing}
          initialType={drawer.newType}
          hosts={hosts}
          groupMap={groupMap}
          running={!!editing && ['running', 'starting'].includes(statusOf(editing.id).state)}
          lastError={editing && statusOf(editing.id).state === 'error' ? statusOf(editing.id).error : null}
          onClose={() => setDrawer(null)}
          onSave={savePortForward}
          onDelete={deletePortForward}
        />
      )}
    </div>
  );
}
