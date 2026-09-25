import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useApp } from '../../contexts/AppContext';
import DuplicateReview from './DuplicateReview';
import { findDuplicateGroups, endpointKey, rankForKeeping } from './duplicates';
import { parseQuickConnect } from './quickConnect';
import {
  ServerIcon, GroupIcon, TerminalIcon, SearchIcon, ChevronDownIcon, ChevronRightIcon,
  PencilIcon, CopyIcon, TrashIcon, FolderIcon, SessionIcon, PlusIcon, CloseIcon, TagIcon, PaletteIcon,
} from '../Icons/icons';
import ViewOptions, { useViewChoice, useSortChoice, sortItems } from '../ViewOptions/ViewOptions';
import { distroFor, DistroLogo } from '../Icons/distros';
import { PALETTE, hostIconBackground } from './hostColor';
import { ColorPopover } from '../ColorPicker/ColorPicker';
import { FEATURES, IS_ANDROID, MACHINE } from '../../platform';
import ActionSheet from '../Mobile/ActionSheet';
import './HostList.css';
import { useBackHandler } from '../../hooks/useBackHandler';

const hostCount = (n) => `${n} ${n === 1 ? 'Host' : 'Hosts'}`;
/* With a tag filter on, a group card says how many of its hosts match */
const matchCount = (n, total, filtering) => (filtering ? `${n} of ${hostCount(total)}` : hostCount(total));
const hostName = (h) => h.label || h.hostname;

export default function HostList() {
  const { state, actions } = useApp();
  const { hosts, groups, activeSessions } = state;
  const {
    connectToHost, openSFTPTab, openHostForm, saveHost, deleteHost, saveGroup, mergeHosts, openLocalTerminal, setHostColor,
  } = actions;

  const [search, setSearch] = useState('');
  const [groupId, setGroupId] = useState(null);
  /* Same localStorage key as the old grid/list toggle, so the choice survives */
  const [view, changeView] = useViewChoice('termilab.hosts.view');
  const [sort, setSort] = useSortChoice('termilab.hosts.sort');
  const [tagFilter, setTagFilter] = useState([]);
  const [contextMenu, setContextMenu] = useState(null);
  /* Colour popover from the context menu: { anchor, hostId } */
  const [colorPicker, setColorPicker] = useState(null);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [showDuplicates, setShowDuplicates] = useState(false);
  const [dragTarget, setDragTarget] = useState(null);
  /* Android: long-press on a host card opens this instead of the context menu */
  const [sheetHost, setSheetHost] = useState(null);
  const searchRef = useRef(null);
  const groupInputRef = useRef(null);
  const newMenuRef = useRef(null);

  /* Android back, innermost first: menus, duplicate review, search, open group.
     Only while home is showing: from a session tab, back goes home instead. */
  const onHome = !state.tabs.some(t => t.id === state.activeTabId);
  useBackHandler(onHome && groupId !== null, () => setGroupId(null));
  useBackHandler(onHome && search !== '', () => setSearch(''));
  useBackHandler(onHome && showDuplicates, () => setShowDuplicates(false));
  useBackHandler(onHome && (!!contextMenu || newMenuOpen), () => { setContextMenu(null); setNewMenuOpen(false); });

  /* Same user@host:port saved more than once. */
  const duplicateGroups = useMemo(() => findDuplicateGroups(hosts), [hosts]);
  /* id → label, the shape DuplicateReview expects */
  const groupsById = useMemo(
    () => Object.fromEntries((groups || []).map(g => [g.id, g.label || g.name])),
    [groups]
  );
  const groupMap = useMemo(
    () => Object.fromEntries((groups || []).map(g => [g.id, g])),
    [groups]
  );
  const undecryptableIds = state.sync?.status?.undecryptableIds || [];
  /* Which hosts are sealed by another computer is only known once this one is
     unlocked: unlocking does the full pull that fills that list. Before that a
     sealed duplicate looks like a host with no password, and merging it away
     would delete the only readable copy on the other computer. Without sync
     nothing propagates, so there is nothing to protect. */
  const syncStatus = state.sync?.status;
  const mergeBlockedReason = !state.sync?.available
    ? null
    : state.sync.loading || !syncStatus
      ? 'Checking sync status…'
      : syncStatus.signedIn && !syncStatus.unlocked
        ? `Unlock this ${MACHINE} in Settings → Sync first. Until then Termilab cannot tell which of these passwords are sealed by another ${MACHINE}, and a merge would delete them there too.`
        : null;

  /* A group that was deleted (here or by sync) while we were inside it */
  const currentGroup = groupId ? groupMap[groupId] || null : null;
  /* A host created while browsing a group starts in that group. */
  const newHostDefaults = currentGroup ? { groupId: currentGroup.id } : null;

  /* ─── Filtering ─── */
  const q = search.trim().toLowerCase();
  const parsedQuick = parseQuickConnect(search);
  /* user@host[:port] of a saved host connects to that host, with its credentials */
  const quickKey = parsedQuick && endpointKey(parsedQuick);
  const savedQuick = quickKey
    ? hosts.filter(h => endpointKey(h) === quickKey).sort(rankForKeeping)[0]
    : null;
  const quickHost = savedQuick || parsedQuick;

  /* Tags in use, and the selected ones that still exist (a host edit can
     remove the last use of a tag while it is selected). */
  const allTags = useMemo(
    () => [...new Set(hosts.flatMap(h => (Array.isArray(h.tags) ? h.tags : [])).filter(t => typeof t === 'string' && t))]
      .sort((a, b) => a.localeCompare(b)),
    [hosts]
  );
  const activeTags = tagFilter.filter(t => allTags.includes(t));
  const tagFiltering = activeTags.length > 0;
  /* ANY selected tag */
  const tagMatches = (h) => !tagFiltering || (h.tags || []).some(t => activeTags.includes(t));

  const textMatches = (h) => !q || [
    h.label, h.hostname, h.username, `${h.username}@${h.hostname}`, ...(h.tags || []),
  ].some(v => typeof v === 'string' && v.toLowerCase().includes(q));
  const hostMatches = (h) => textMatches(h) && tagMatches(h);

  const hostsInGroup = (id) => hosts.filter(h => h.groupId === id);
  const matchingInGroup = (id) => hostsInGroup(id).filter(tagMatches).length;

  let visibleGroups = [];
  let visibleHosts;
  if (currentGroup) {
    visibleHosts = hostsInGroup(currentGroup.id).filter(hostMatches);
  } else if (q) {
    /* Searching from the top level looks through every group */
    visibleGroups = groups.filter(g => (g.label || '').toLowerCase().includes(q)
      && (!tagFiltering || matchingInGroup(g.id) > 0));
    visibleHosts = hosts.filter(hostMatches);
  } else {
    /* Filtering by tag keeps the groups that hold a match, with their count */
    visibleGroups = tagFiltering ? groups.filter(g => matchingInGroup(g.id) > 0) : groups;
    /* A host pointing at a group that no longer exists would vanish otherwise */
    visibleHosts = hosts.filter(h => (!h.groupId || !groupMap[h.groupId]) && tagMatches(h));
  }
  visibleGroups = sortItems(visibleGroups, sort, { label: g => g.label, date: g => g.createdAt });
  visibleHosts = sortItems(visibleHosts, sort, { label: hostName, date: h => h.createdAt });

  const isConnected = (hostId) =>
    Object.values(activeSessions).some(s => s.hostId === hostId);

  /* ─── Connect ─── */
  const handleConnect = useCallback(async (host) => {
    try {
      await connectToHost(host);
    } catch (err) {
      console.error('Connection failed:', err);
    }
  }, [connectToHost]);

  /* An empty box is not a request to connect, even with one host showing */
  const canSubmit = !!q && (!!quickHost || visibleHosts.length === 1);
  const submitSearch = () => {
    if (!canSubmit) return;
    if (quickHost) {
      handleConnect(quickHost);
      setSearch('');
    } else if (visibleHosts.length === 1) {
      handleConnect(visibleHosts[0]);
    }
  };

  const handleSearchKeyDown = (e) => {
    if (e.key === 'Enter') submitSearch();
    if (e.key === 'Escape') setSearch('');
  };

  /* ─── Menus: close on any outside click ─── */
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

  const handleContextMenu = (e, host) => {
    e.preventDefault();
    e.stopPropagation();
    /* A long-press fires contextmenu on Android: an action sheet, not a menu */
    if (IS_ANDROID) { setSheetHost(host); return; }
    /* Keep the menu on screen near the right and bottom edges */
    const x = Math.min(e.clientX, window.innerWidth - 200);
    const y = Math.min(e.clientY, window.innerHeight - 280);
    setContextMenu({ x, y, host });
  };

  /* Context menu actions — the same set the old sidebar list had */
  const ctxConnect = () => contextMenu && handleConnect(contextMenu.host);
  const ctxNewSession = () => contextMenu && connectToHost(contextMenu.host);
  const ctxSftp = () => contextMenu && openSFTPTab(contextMenu.host);
  const ctxEdit = () => contextMenu && openHostForm(contextMenu.host);
  const ctxDuplicate = () => {
    if (contextMenu) {
      const dup = { ...contextMenu.host, id: undefined, label: `${contextMenu.host.label} (copy)` };
      saveHost(dup);
    }
  };
  const ctxDelete = () => contextMenu && deleteHost(contextMenu.host.id);
  /* Opens where the menu was; the menu itself closes on this same click */
  const ctxColor = () => {
    if (!contextMenu) return;
    const { x, y, host } = contextMenu;
    setColorPicker({ anchor: { left: x, top: y, right: x, bottom: y }, hostId: host.id });
  };
  const closeColorPicker = useCallback(() => setColorPicker(null), []);
  const pickerHost = colorPicker ? hosts.find(h => h.id === colorPicker.hostId) : null;

  /* ─── New group — inline input ─── */
  const handleNewGroup = () => {
    setNewMenuOpen(false);
    setGroupId(null);
    setShowNewGroup(true);
    setNewGroupName('');
    setTimeout(() => groupInputRef.current?.focus(), 50);
  };

  const submitNewGroup = async () => {
    if (newGroupName.trim()) {
      const hue = Math.floor(Math.random() * 360);
      await saveGroup({ label: newGroupName.trim(), color: `hsl(${hue}, 55%, 55%)` });
    }
    setShowNewGroup(false);
    setNewGroupName('');
  };

  /* ─── Drag a host onto a group card (or onto "Hosts" to ungroup it) ─── */
  const handleDragStart = (e, host) => {
    e.dataTransfer.setData('text/plain', host.id);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e, target) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragTarget(target);
  };

  const handleDragLeave = () => setDragTarget(null);

  const handleDrop = async (e, targetGroupId) => {
    e.preventDefault();
    setDragTarget(null);
    const hostId = e.dataTransfer.getData('text/plain');
    const host = hosts.find(h => h.id === hostId);
    if (host) {
      try {
        await saveHost({ ...host, groupId: targetGroupId || null });
      } catch (err) {
        window.alert(err?.message || 'Could not move this host.');
      }
    }
  };

  const enterGroup = (id) => {
    setGroupId(id);
    setSearch('');
  };

  /* ─── Render pieces ─── */
  const renderGroup = (group) => {
    const total = hostsInGroup(group.id).length;
    const count = matchingInGroup(group.id);
    return (
      <div
        key={group.id}
        className={`hv-card hv-group ${dragTarget === group.id ? 'drag-over' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => enterGroup(group.id)}
        onKeyDown={(e) => { if (e.key === 'Enter') enterGroup(group.id); }}
        onDragOver={(e) => handleDragOver(e, group.id)}
        onDragLeave={handleDragLeave}
        onDrop={(e) => handleDrop(e, group.id)}
      >
        <div className="hv-icon" style={{ background: group.color || PALETTE[0] }}>
          <GroupIcon />
        </div>
        <div className="hv-card-text">
          <div className="hv-card-label">{group.label}</div>
          <div className="hv-card-sub">{matchCount(count, total, tagFiltering)}</div>
        </div>
      </div>
    );
  };

  const renderHost = (host) => {
    const connected = isConnected(host.id);
    const displayLabel = host.label || host.hostname;
    const address = `${host.username}@${host.hostname}${host.port && host.port !== 22 ? `:${host.port}` : ''}`;
    const groupLabel = !currentGroup && q && host.groupId && groupMap[host.groupId]?.label;
    const distro = distroFor(host.os);

    return (
      <div
        key={host.id}
        className={`hv-card hv-host ${connected ? 'connected' : ''}`}
        role="button"
        tabIndex={0}
        title={address}
        draggable
        onDragStart={(e) => handleDragStart(e, host)}
        onClick={() => handleConnect(host)}
        onKeyDown={(e) => { if (e.key === 'Enter') handleConnect(host); }}
        onContextMenu={(e) => handleContextMenu(e, host)}
      >
        <div
          className={`hv-icon ${distro ? 'hv-icon-distro' : ''}`}
          style={{ background: hostIconBackground(host, distro, groupMap) }}
          title={distro ? distro.label : undefined}
        >
          {distro ? <DistroLogo os={host.os} /> : <ServerIcon />}
          {connected && <span className="hv-icon-dot" aria-label="Connected" />}
        </div>
        <div className="hv-card-text">
          <div className="hv-card-label">{displayLabel}</div>
          <div className="hv-card-sub">
            ssh, {host.username}
            {groupLabel ? <span className="hv-card-group"> · {groupLabel}</span> : null}
          </div>
        </div>
        {view === 'list' && <div className="hv-row-address">{address}</div>}
        <button
          className="hv-card-edit"
          title="Edit host"
          aria-label={`Edit ${displayLabel}`}
          onClick={(e) => { e.stopPropagation(); openHostForm(host); }}
        >
          <PencilIcon />
        </button>
      </div>
    );
  };

  const noHostsAtAll = hosts.length === 0 && groups.length === 0;
  const showGroupsSection = !currentGroup && (visibleGroups.length > 0 || showNewGroup);
  const nothingMatches = !noHostsAtAll && visibleHosts.length === 0 && visibleGroups.length === 0;

  return (
    <div className="hosts-view">
      <div className="hv-top">
        {/* Search / quick connect */}
        <div className="hv-search">
          <SearchIcon className="hv-search-icon" />
          <input
            ref={searchRef}
            type="text"
            placeholder="Find a host or ssh user@hostname…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            spellCheck={false}
            aria-label="Find a host or connect with user@hostname"
          />
          {search && (
            <button className="hv-search-clear" onClick={() => setSearch('')} aria-label="Clear search">
              <CloseIcon />
            </button>
          )}
          <button className="hv-connect-btn" onClick={submitSearch} disabled={!canSubmit}>
            Connect
          </button>
        </div>
        {quickHost && (
          <div className="hv-quick-hint">
            Press Enter to connect to <strong>{quickHost.username}@{quickHost.hostname}</strong>
            {(Number(quickHost.port) || 22) !== 22 ? <> on port <strong>{quickHost.port}</strong></> : null}
            {savedQuick ? <> using saved host <strong>{savedQuick.label || savedQuick.hostname}</strong></> : null}
          </div>
        )}

        {/* Action row (Android: the FAB makes hosts, so only "New group" here) */}
        <div className="hv-actions">
          {IS_ANDROID && (
            <button className="hv-btn" onClick={handleNewGroup}>
              <GroupIcon />
              New group
            </button>
          )}
          {!IS_ANDROID && <div className="hv-split" ref={newMenuRef}>
            <button className="hv-btn hv-btn-primary hv-split-main" onClick={() => openHostForm(null, newHostDefaults)}>
              <ServerIcon />
              New host
            </button>
            <button
              className="hv-btn hv-btn-primary hv-split-toggle"
              aria-label="More new items"
              aria-expanded={newMenuOpen}
              onClick={() => setNewMenuOpen(o => !o)}
            >
              <ChevronDownIcon />
            </button>
            {newMenuOpen && (
              <div className="hv-menu hv-split-menu">
                <button className="hv-menu-item" onClick={() => { setNewMenuOpen(false); openHostForm(null, newHostDefaults); }}>
                  <ServerIcon /> New host
                </button>
                <button className="hv-menu-item" onClick={handleNewGroup}>
                  <GroupIcon /> New group
                </button>
              </div>
            )}
          </div>}
          {FEATURES.localTerminal && (
            <button className="hv-btn" onClick={openLocalTerminal}>
              <TerminalIcon />
              Terminal
            </button>
          )}

          <div className="hv-actions-spacer" />

          <ViewOptions
            view={view}
            onViewChange={changeView}
            sort={sort}
            onSortChange={setSort}
            tags={allTags}
            selectedTags={activeTags}
            onTagsChange={setTagFilter}
          />
        </div>
      </div>

      <div className="hv-scroll">
        {duplicateGroups.length > 0 && !showDuplicates && (
          <button className="dup-banner" onClick={() => setShowDuplicates(true)}>
            <span>
              {duplicateGroups.length === 1
                ? '1 server is saved more than once'
                : `${duplicateGroups.length} servers are saved more than once`}
            </span>
            <span className="dup-banner-action">Review</span>
          </button>
        )}
        {showDuplicates && duplicateGroups.length > 0 && (
          <DuplicateReview
            duplicateGroups={duplicateGroups}
            groupsById={groupsById}
            undecryptableIds={undecryptableIds}
            mergeBlockedReason={mergeBlockedReason}
            onMerge={mergeHosts}
            onClose={() => setShowDuplicates(false)}
          />
        )}

        {currentGroup && (
          <nav className="hv-breadcrumb" aria-label="Breadcrumb">
            <button
              className={`hv-crumb ${dragTarget === '__root' ? 'drag-over' : ''}`}
              onClick={() => enterGroup(null)}
              onDragOver={(e) => handleDragOver(e, '__root')}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, null)}
              title="Back to all hosts (drop a host here to take it out of the group)"
            >
              Hosts
            </button>
            <ChevronRightIcon className="hv-crumb-sep" />
            <span className="hv-crumb-current">{currentGroup.label}</span>
            <span className="hv-crumb-count">
              {matchCount(matchingInGroup(currentGroup.id), hostsInGroup(currentGroup.id).length, tagFiltering)}
            </span>
          </nav>
        )}

        {noHostsAtAll && !showNewGroup ? (
          <div className="hv-empty">
            <div className="hv-empty-icon"><ServerIcon /></div>
            <h3>No hosts yet</h3>
            <p>Add your first server, or type <code>user@hostname</code> above to connect right away.</p>
            <button className="hv-btn hv-btn-primary" onClick={() => openHostForm(null, newHostDefaults)}>
              <PlusIcon /> New host
            </button>
          </div>
        ) : nothingMatches && !showNewGroup ? (
          <div className="hv-empty">
            <div className="hv-empty-icon"><SearchIcon /></div>
            {q ? (
              <>
                <h3>No hosts match “{search.trim()}”{tagFiltering ? ' with the selected tags' : ''}</h3>
                <p>{parsedQuick && !savedQuick ? 'Press Enter or Connect to open it as a one-off connection.' : 'Try a label, hostname, username or tag.'}</p>
              </>
            ) : tagFiltering ? (
              <>
                <h3>No hosts {currentGroup ? 'in this group ' : ''}with {activeTags.length === 1 ? `the tag “${activeTags[0]}”` : 'any of the selected tags'}</h3>
                <p>
                  <button className="hv-btn" onClick={() => setTagFilter([])}><TagIcon /> Clear tag filter</button>
                </p>
              </>
            ) : (
              <>
                <h3>This group is empty</h3>
                <p>Drag a host onto the group card, or pick the group in a host’s editor.</p>
              </>
            )}
          </div>
        ) : (
          <>
            {showGroupsSection && (
              <section className="hv-section">
                <h4 className="hv-section-title">Groups</h4>
                <div className={`hv-grid ${view === 'list' ? 'hv-list' : ''}`}>
                  {showNewGroup && (
                    <div className="hv-card hv-group hv-new-group">
                      <div className="hv-icon hv-icon-muted"><GroupIcon /></div>
                      <input
                        ref={groupInputRef}
                        type="text"
                        placeholder="Group name"
                        value={newGroupName}
                        onChange={e => setNewGroupName(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') submitNewGroup();
                          if (e.key === 'Escape') { setShowNewGroup(false); setNewGroupName(''); }
                        }}
                        onBlur={submitNewGroup}
                      />
                    </div>
                  )}
                  {visibleGroups.map(renderGroup)}
                </div>
              </section>
            )}

            {visibleHosts.length > 0 && (
              <section className="hv-section">
                {/* Inside a group the breadcrumb already says where you are */}
                {!currentGroup && <h4 className="hv-section-title">Hosts</h4>}
                <div className={`hv-grid ${view === 'list' ? 'hv-list' : ''}`}>
                  {visibleHosts.map(renderHost)}
                </div>
              </section>
            )}
          </>
        )}
      </div>

      {IS_ANDROID && (
        <button
          className="m-fab"
          onClick={() => openHostForm(null, newHostDefaults)}
          aria-label={currentGroup ? `New host in ${currentGroup.label}` : 'New host'}
        >
          <PlusIcon />
        </button>
      )}
      {sheetHost && (
        <ActionSheet
          title={hostName(sheetHost)}
          subtitle={`${sheetHost.username}@${sheetHost.hostname}${sheetHost.port && sheetHost.port !== 22 ? `:${sheetHost.port}` : ''}`}
          onClose={() => setSheetHost(null)}
          actions={[
            { id: 'connect', label: 'Connect', Icon: TerminalIcon, onSelect: () => handleConnect(sheetHost) },
            { id: 'edit', label: 'Edit', Icon: PencilIcon, onSelect: () => openHostForm(sheetHost) },
            { id: 'duplicate', label: 'Duplicate', Icon: CopyIcon, onSelect: () => saveHost({ ...sheetHost, id: undefined, label: `${sheetHost.label} (copy)` }) },
            {
              id: 'delete', label: 'Delete', Icon: TrashIcon, danger: true,
              onSelect: () => { if (window.confirm(`Delete "${hostName(sheetHost)}"?`)) deleteHost(sheetHost.id); },
            },
          ]}
        />
      )}

      {pickerHost && (
        <ColorPopover
          anchor={colorPicker.anchor}
          value={pickerHost.color}
          title={`Color of ${hostName(pickerHost)}`}
          onPick={(hex) => setHostColor(pickerHost.id, hex)}
          onClose={closeColorPicker}
        />
      )}

      {/* Context menu */}
      {contextMenu && (
        <div
          className="host-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button className="host-context-menu-item" onClick={ctxConnect}>
            <TerminalIcon /> Connect
          </button>
          <button className="host-context-menu-item" onClick={ctxNewSession}>
            <SessionIcon /> New Session
          </button>
          {FEATURES.sftp && (
            <button className="host-context-menu-item" onClick={ctxSftp}>
              <FolderIcon /> Open SFTP
            </button>
          )}
          <div className="host-context-separator" />
          <button className="host-context-menu-item" onClick={ctxEdit}>
            <PencilIcon /> Edit
          </button>
          <button className="host-context-menu-item" onClick={ctxDuplicate}>
            <CopyIcon /> Duplicate
          </button>
          <button className="host-context-menu-item" onClick={ctxColor}>
            <PaletteIcon /> Color
          </button>
          <div className="host-context-separator" />
          <button className="host-context-menu-item danger" onClick={ctxDelete}>
            <TrashIcon /> Delete
          </button>
        </div>
      )}
    </div>
  );
}
