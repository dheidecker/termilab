import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useApp } from '../../contexts/AppContext';
import { VaultIcon, ServerIcon, TerminalIcon, FolderIcon, PlusIcon, CloseIcon, BroadcastIcon, PaletteIcon } from '../Icons/icons';
import { FEATURES } from '../../platform';
import './TabBar.css';
import { useBackHandler } from '../../hooks/useBackHandler';
import { confirmCloseSftp } from '../SFTP/activeTransfers';
import { memberTabs, groupLabel, groupOf, isTerminalTab } from '../SplitPane/layoutTree';
import { useDrag, beginDrag, setDrag } from '../SplitPane/dragState';
import { confirmCloseSessions, endSessions } from '../SplitPane/sessions';
import { tabColor } from '../HostList/hostColor';
import { ColorPopover, anchorOf } from '../ColorPicker/ColorPicker';

/* Hovering a dragged tab/pane over another tab opens it after this long, so
   the drop can land in its panes (like browsers do) */
const HOVER_OPEN_MS = 500;

function getTabIcon(tab) {
  if (tab.type === 'sftp') return <FolderIcon className="tab-icon" />;
  if (tab.type === 'local-terminal') return <TerminalIcon className="tab-icon" />;
  return <ServerIcon className="tab-icon" />;
}

/**
 * The tab strip, drawn inside the title bar. The first tab is the permanent
 * home tab (Hosts, Keychain, … — whatever the sidebar picks); it is not in
 * `state.tabs` and is active whenever `activeTabId` is null. Session tabs
 * follow, then "+" for a new local terminal.
 */
export default function TabBar() {
  const { state, actions } = useApp();
  const { tabs, activeTabId, broadcast } = state;
  const [contextMenu, setContextMenu] = useState(null);
  /* Colour popover from the active tab: { anchor, el, paneId, groupId }. It
     colours the pane the tab shows the colour of (the first/top-left one). */
  const [picker, setPicker] = useState(null);
  const closePicker = useCallback(() => setPicker(null), []);
  useBackHandler(!!contextMenu, () => setContextMenu(null));

  const visibleTabs = tabs.filter(t => !t.hidden);
  const homeActive = !tabs.some(t => t.id === activeTabId);
  const drag = useDrag();
  const hoverRef = useRef({ id: null, timer: null });
  /* The tab a drag comes from: hovering it opens nothing */
  const dragGroup = drag ? (drag.kind === 'tab' ? drag.tabId : groupOf(state, drag.paneId)) : null;
  const paneDrag = drag?.kind === 'pane';

  const clearHover = () => {
    clearTimeout(hoverRef.current.timer);
    hoverRef.current = { id: null, timer: null };
  };
  useEffect(() => { if (!drag) clearHover(); }, [drag]);
  useEffect(() => clearHover, []);

  /* The popover belongs to the tab on screen: another tab opened, or that
     pane closed/moved elsewhere, closes it */
  const pickerPane = picker && picker.groupId === activeTabId ? tabs.find(t => t.id === picker.paneId) : null;
  const pickerLive = !!pickerPane && memberTabs(state, picker.groupId)[0]?.id === picker.paneId;
  useEffect(() => { if (picker && !pickerLive) setPicker(null); }, [picker, pickerLive]);

  /* Close the context menu on outside click */
  useEffect(() => {
    const handler = () => setContextMenu(null);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

  /* A split tab closes every pane in it (one question for all of them) */
  const handleCloseTab = useCallback(async (tabId) => {
    const tab = tabs.find(t => t.id === tabId);
    const members = isTerminalTab(tab) ? memberTabs(state, tabId) : (tab ? [tab] : []);
    // Confirm before closing active terminal/SSH sessions
    if (!confirmCloseSessions(members, groupLabel(members).label)) return;
    if (!confirmCloseSftp(tab)) return;
    await endSessions(members, actions.disconnectSession);
    actions.removeTab(members.map(t => t.id));
  }, [tabs, state, actions]);

  /* Middle-click to close */
  const handleMouseDown = (e, tabId) => {
    if (e.button === 1) {
      e.preventDefault();
      handleCloseTab(tabId);
    }
  };

  const handleContextMenu = (e, tab) => {
    e.preventDefault();
    setContextMenu({ x: Math.min(e.clientX, window.innerWidth - 170), y: e.clientY, tab });
  };

  const closeOtherTabs = () => {
    if (!contextMenu) return;
    visibleTabs.forEach(t => {
      if (t.id !== contextMenu.tab.id) {
        handleCloseTab(t.id);
      }
    });
  };

  /* ── Drag and drop ──
     A terminal tab drags onto a pane of the open tab (SessionStage draws the
     drop zones). A pane dropped anywhere on this bar becomes its own tab. */
  const hoverOpen = (tab) => {
    if (!drag || tab.id === activeTabId || tab.id === dragGroup || !isTerminalTab(tab)) return;
    if (hoverRef.current.id === tab.id) return;
    clearHover();
    hoverRef.current = {
      id: tab.id,
      timer: setTimeout(() => { hoverRef.current.timer = null; actions.setActiveTab(tab.id); }, HOVER_OPEN_MS),
    };
  };
  const hoverLeave = (e, tab) => {
    if (e.currentTarget.contains(e.relatedTarget)) return;
    if (hoverRef.current.id === tab.id) clearHover();
  };
  const barDragOver = (e) => {
    if (!paneDrag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };
  const barDrop = (e) => {
    if (!paneDrag) return;
    e.preventDefault();
    actions.detachPane(drag.paneId);
    setDrag(null);
  };

  return (
    <div
      className={`tab-bar${paneDrag ? ' tab-bar-dropping' : ''}`}
      onDragOver={barDragOver}
      onDrop={barDrop}
    >
      <div className="tab-bar-tabs" role="tablist">
        <div
          className={`tab tab-home ${homeActive ? 'active' : ''}`}
          role="tab"
          aria-selected={homeActive}
          tabIndex={0}
          onClick={actions.goHome}
          onKeyDown={(e) => { if (e.key === 'Enter') actions.goHome(); }}
        >
          <VaultIcon className="tab-icon" />
          <span className="tab-label">Hosts</span>
        </div>

        {visibleTabs.map(tab => {
          /* A split tab: "first host +N", every pane in the tooltip */
          const members = isTerminalTab(tab) ? memberTabs(state, tab.id) : [tab];
          const { label, title } = groupLabel(members);
          const notify = members.some(m => m.notify);
          const canDrag = FEATURES.splitPanes && isTerminalTab(tab);
          /* A split tab shows its first (top-left) pane's colour */
          const lead = isTerminalTab(tab) ? members[0] : null;
          const color = lead ? tabColor(lead, state.hosts) : null;
          const isActive = tab.id === activeTabId;
          return (
          <div
            key={tab.id}
            className={`tab ${isActive ? 'active' : ''} ${notify ? 'notify' : ''} ${drag?.kind === 'tab' && tab.id === drag.tabId ? 'dragging' : ''}${color ? ' has-color' : ''}`}
            style={color ? { '--tab-color': color } : undefined}
            role="tab"
            aria-selected={tab.id === activeTabId}
            title={title}
            draggable={canDrag}
            onDragStart={canDrag ? (e) => beginDrag(e, { kind: 'tab', tabId: tab.id }, label) : undefined}
            onDragEnd={canDrag ? () => setDrag(null) : undefined}
            onDragOver={() => hoverOpen(tab)}
            onDragLeave={(e) => hoverLeave(e, tab)}
            onClick={() => actions.setActiveTab(tab.id)}
            onMouseDown={(e) => handleMouseDown(e, tab.id)}
            onContextMenu={(e) => handleContextMenu(e, tab)}
          >
            {(tab.type === 'local-terminal' || tab.type === 'ssh') && (
              <span className={`tab-status ${tab.sessionId ? 'connected' : 'disconnected'}`} />
            )}
            {getTabIcon(tab)}
            <span className="tab-label">{label}</span>
            {isActive && lead && (
              <button
                className={`tab-color-btn${picker ? ' open' : ''}`}
                title={members.length > 1 ? `Color of ${lead.label || 'Terminal'}` : 'Color'}
                aria-label={`Color of ${lead.label || 'Terminal'}`}
                aria-haspopup="dialog"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  const el = e.currentTarget;
                  setPicker(p => (p ? null : { anchor: anchorOf(el), el, paneId: lead.id, groupId: tab.id }));
                }}
              >
                <PaletteIcon />
              </button>
            )}
            <button
              className="tab-close"
              aria-label={`Close ${label}`}
              onClick={(e) => {
                e.stopPropagation();
                handleCloseTab(tab.id);
              }}
            >
              <CloseIcon />
            </button>
          </div>
          );
        })}
      </div>

      {FEATURES.localTerminal && (
        <button
          className="tab-add-btn"
          onClick={actions.openLocalTerminal}
          title="New local terminal (Ctrl+T)"
          aria-label="New local terminal"
        >
          <PlusIcon />
        </button>
      )}

      {/* Empty strip: drags the window (not while a pane is being dragged:
          then the whole bar is a drop target) */}
      <div className="tab-bar-drag">
        {paneDrag && <span className="tab-bar-drop-hint">Drop here to move to a new tab</span>}
      </div>

      {broadcast && (
        <div className="broadcast-indicator">
          <BroadcastIcon />
          <span>Broadcast</span>
        </div>
      )}
      <button
        className={`broadcast-toggle-btn ${broadcast ? 'active' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          actions.toggleBroadcast();
        }}
        title={broadcast ? 'Disable Broadcast Input' : 'Enable Broadcast Input — type in all tabs at once'}
      >
        <BroadcastIcon />
      </button>

      {pickerLive && (
        <ColorPopover
          anchor={picker.anchor}
          ignoreEl={picker.el}
          value={tabColor(pickerPane, state.hosts)}
          title={`This terminal · ${pickerPane.label || 'Terminal'}`}
          onPick={(hex) => actions.setTabColor(pickerPane.id, hex)}
          onClose={closePicker}
        />
      )}

      {/* Tab context menu */}
      {contextMenu && (
        <div
          className="tab-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <button className="tab-context-menu-item" onClick={() => handleCloseTab(contextMenu.tab.id)}>
            Close
          </button>
          {FEATURES.splitPanes && memberTabs(state, contextMenu.tab.id).length > 1 && (
            <button className="tab-context-menu-item" onClick={() => actions.ungroupTab(contextMenu.tab.id)}>
              Move Panes to Separate Tabs
            </button>
          )}
          <button className="tab-context-menu-item" onClick={closeOtherTabs}>
            Close Others
          </button>
          <button
            className="tab-context-menu-item danger"
            onClick={() => visibleTabs.forEach(t => handleCloseTab(t.id))}
          >
            Close All
          </button>
        </div>
      )}
    </div>
  );
}
