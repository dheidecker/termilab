import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useApp } from '../../contexts/AppContext';
import './HostList.css';

/* Generate a stable color from a string */
function hashColor(str) {
  let hash = 0;
  for (let i = 0; i < (str || '').length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash % 360);
  return `hsl(${hue}, 55%, 55%)`;
}

/* Get initials from label */
function getInitials(label) {
  if (!label) return '?';
  const words = label.trim().split(/\s+/);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return label.substring(0, 2).toUpperCase();
}

export default function HostList({ sftpMode = false }) {
  const { state, actions } = useApp();
  const { hosts, groups, activeSessions } = state;
  const [search, setSearch] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState({});
  const [contextMenu, setContextMenu] = useState(null);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [dragTarget, setDragTarget] = useState(null);
  const menuRef = useRef(null);
  const groupInputRef = useRef(null);

  /* Filter hosts */
  const filteredHosts = hosts.filter(h => {
    const q = search.toLowerCase();
    return (
      h.label?.toLowerCase().includes(q) ||
      h.hostname?.toLowerCase().includes(q) ||
      h.username?.toLowerCase().includes(q)
    );
  });

  /* Group hosts */
  const groupedHosts = {};
  const ungrouped = [];
  filteredHosts.forEach(h => {
    if (h.groupId) {
      if (!groupedHosts[h.groupId]) groupedHosts[h.groupId] = [];
      groupedHosts[h.groupId].push(h);
    } else {
      ungrouped.push(h);
    }
  });

  const isConnected = (hostId) =>
    Object.values(activeSessions).some(s => s.hostId === hostId);

  const toggleGroup = (groupId) =>
    setCollapsedGroups(prev => ({ ...prev, [groupId]: !prev[groupId] }));

  /* Connect */
  const handleConnect = useCallback(async (host) => {
    try {
      if (sftpMode) {
        await actions.openSFTPTab(host);
      } else {
        await actions.connectToHost(host);
      }
    } catch (err) {
      console.error('Connection failed:', err);
    }
  }, [actions, sftpMode]);

  /* Right-click context menu */
  const handleContextMenu = (e, host) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, host });
  };

  /* Close context menu on click outside */
  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    if (contextMenu) {
      document.addEventListener('click', handleClick);
      return () => document.removeEventListener('click', handleClick);
    }
  }, [contextMenu]);

  /* Context menu actions */
  const ctxConnect = () => contextMenu && handleConnect(contextMenu.host);
  const ctxSftp = () => contextMenu && actions.openSFTPTab(contextMenu.host);
  const ctxEdit = () => contextMenu && actions.openHostForm(contextMenu.host);
  const ctxDuplicate = () => {
    if (contextMenu) {
      const dup = { ...contextMenu.host, id: undefined, label: `${contextMenu.host.label} (copy)` };
      actions.saveHost(dup);
    }
  };
  const ctxDelete = () => contextMenu && actions.deleteHost(contextMenu.host.id);

  /* New group — inline input */
  const handleNewGroup = () => {
    setShowNewGroup(true);
    setNewGroupName('');
    setTimeout(() => groupInputRef.current?.focus(), 50);
  };

  const submitNewGroup = async () => {
    if (newGroupName.trim()) {
      const hue = Math.floor(Math.random() * 360);
      await actions.saveGroup({ label: newGroupName.trim(), color: `hsl(${hue}, 55%, 55%)` });
    }
    setShowNewGroup(false);
    setNewGroupName('');
  };

  /* ─── Drag & Drop ─── */
  const handleDragStart = (e, host) => {
    e.dataTransfer.setData('text/plain', host.id);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e, groupId) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragTarget(groupId);
  };

  const handleDragLeave = () => setDragTarget(null);

  const handleDrop = async (e, groupId) => {
    e.preventDefault();
    setDragTarget(null);
    const hostId = e.dataTransfer.getData('text/plain');
    const host = hosts.find(h => h.id === hostId);
    if (host) {
      await actions.saveHost({ ...host, groupId: groupId || null });
    }
  };

  /* Chevron icon */
  const Chevron = ({ collapsed }) => (
    <svg className={`host-group-chevron ${collapsed ? 'collapsed' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );

  /* Render a host card */
  const renderHost = (host) => {
    const color = hashColor(host.label || host.hostname);
    const connected = isConnected(host.id);
    const displayLabel = host.label || host.hostname;

    return (
      <div
        key={host.id}
        className={`host-card ${connected ? 'connected' : ''}`}
        draggable
        onDragStart={(e) => handleDragStart(e, host)}
        onClick={() => handleConnect(host)}
        onContextMenu={(e) => handleContextMenu(e, host)}
      >
        {/* Avatar */}
        <div className="host-card-avatar" style={{ background: color }}>
          <span>{getInitials(displayLabel)}</span>
          {connected && <div className="host-card-status-dot" />}
        </div>

        {/* Info */}
        <div className="host-card-info">
          <div className="host-card-label">{displayLabel}</div>
          <div className="host-card-address">
            {host.username}@{host.hostname}{host.port && host.port !== 22 ? `:${host.port}` : ''}
          </div>
        </div>

        {/* Actions on hover */}
        <div className="host-card-actions">
          <button
            className="host-card-action-btn"
            title="Edit"
            onClick={(e) => { e.stopPropagation(); actions.openHostForm(host); }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </button>
          <button
            className="host-card-action-btn"
            title="SFTP"
            onClick={(e) => { e.stopPropagation(); actions.openSFTPTab(host); }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2v11z" />
            </svg>
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="host-list">
      <div className="host-list-header">
        <h2>{sftpMode ? 'SFTP' : 'Hosts'}</h2>
        <div className="host-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            placeholder="Search hosts..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <div className="host-list-actions">
          <button className="host-list-action-btn primary" onClick={() => actions.openHostForm()}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New Host
          </button>
          <button className="host-list-action-btn" onClick={handleNewGroup}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Group
          </button>
        </div>
        {showNewGroup && (
          <div className="host-new-group-input">
            <input
              ref={groupInputRef}
              type="text"
              placeholder="Group name..."
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
      </div>

      <div className="host-list-content">
        {filteredHosts.length === 0 ? (
          <div className="host-list-empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="7" rx="1.5" />
              <rect x="2" y="14" width="20" height="7" rx="1.5" />
              <circle cx="6" cy="6.5" r="1" fill="currentColor" stroke="none" />
              <circle cx="6" cy="17.5" r="1" fill="currentColor" stroke="none" />
            </svg>
            <p>
              No hosts yet.<br />
              Add your first server to get started.
            </p>
          </div>
        ) : (
          <>
            {groups.map(group => {
              const groupHosts = groupedHosts[group.id] || [];
              if (groupHosts.length === 0 && search) return null;
              const collapsed = collapsedGroups[group.id];
              return (
                <div key={group.id} className="host-group">
                  <div
                    className={`host-group-header ${dragTarget === group.id ? 'drag-over' : ''}`}
                    onClick={() => toggleGroup(group.id)}
                    onDragOver={(e) => handleDragOver(e, group.id)}
                    onDragLeave={handleDragLeave}
                    onDrop={(e) => handleDrop(e, group.id)}
                  >
                    <Chevron collapsed={collapsed} />
                    <div className="host-group-color" style={{ background: group.color || '#58a6ff' }} />
                    <span className="host-group-label">{group.label}</span>
                    <span className="host-group-count">{groupHosts.length}</span>
                  </div>
                  {!collapsed && (
                    <div className="host-group-items">
                      {groupHosts.map(renderHost)}
                    </div>
                  )}
                </div>
              );
            })}
            {ungrouped.length > 0 && (
              <div className="host-group">
                {groups.length > 0 && (
                  <div
                    className={`host-group-header ${dragTarget === '__ungrouped' ? 'drag-over' : ''}`}
                    onClick={() => toggleGroup('__ungrouped')}
                    onDragOver={(e) => handleDragOver(e, '__ungrouped')}
                    onDragLeave={handleDragLeave}
                    onDrop={(e) => handleDrop(e, null)}
                  >
                    <Chevron collapsed={collapsedGroups['__ungrouped']} />
                    <span className="host-group-label">Ungrouped</span>
                    <span className="host-group-count">{ungrouped.length}</span>
                  </div>
                )}
                {(!collapsedGroups['__ungrouped'] || groups.length === 0) && (
                  <div className="host-group-items">
                    {ungrouped.map(renderHost)}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={menuRef}
          className="host-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <button className="host-context-menu-item" onClick={ctxConnect}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
            Connect
          </button>
          <button className="host-context-menu-item" onClick={() => {
            if (contextMenu) {
              // Open a second session to the same host
              actions.connectToHost(contextMenu.host);
            }
          }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="7" rx="1.5" />
              <rect x="2" y="14" width="20" height="7" rx="1.5" />
              <line x1="12" y1="10" x2="12" y2="14" />
            </svg>
            New Session
          </button>
          <button className="host-context-menu-item" onClick={ctxSftp}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2v11z" />
            </svg>
            Open SFTP
          </button>
          <div className="host-context-separator" />
          <button className="host-context-menu-item" onClick={ctxEdit}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            Edit
          </button>
          <button className="host-context-menu-item" onClick={ctxDuplicate}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
            </svg>
            Duplicate
          </button>
          <div className="host-context-separator" />
          <button className="host-context-menu-item danger" onClick={ctxDelete}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
            </svg>
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
