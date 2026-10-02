import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useApp } from '../../contexts/AppContext';
import { VaultIcon, ServerIcon, TerminalIcon, FolderIcon, PlusIcon, CloseIcon, BroadcastIcon, PaletteIcon } from '../Icons/icons';
import { FEATURES } from '../../platform';
import AgentDot from '../Agents/AgentDot';
import { leadAgent, agentTooltip } from '../Terminal/agentRules';
import './TabBar.css';
import { useBackHandler } from '../../hooks/useBackHandler';
import { confirmCloseSftp } from '../SFTP/activeTransfers';
import { memberTabs, groupLabel, groupOf, isTerminalTab, paneName, paneTitle, cleanAlias } from '../SplitPane/layoutTree';
import InlineRename from '../SplitPane/InlineRename';
import { useDrag, beginDrag, setDrag, DRAG_MIME, isLocalDrag } from '../SplitPane/dragState';
import { cannotMove, selfWindowId, windowInfo, requestMoveHere, dropTarget } from '../SplitPane/windowMove';
import { confirmCloseSessions, endSessions } from '../SplitPane/sessions';
import { planKeeperClose } from '../Keeper/closePlan';
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
  const visualAlerts = state.settings?.terminal?.visualAlerts !== false;
  const { tabs, activeTabId, broadcast } = state;
  const [contextMenu, setContextMenu] = useState(null);
  /* Colour popover from the active tab: { anchor, el, paneId, groupId }. It
     colours the pane the tab shows the colour of (the first/top-left one). */
  const [picker, setPicker] = useState(null);
  const closePicker = useCallback(() => setPicker(null), []);
  /* Inline rename of a tab's lead pane (the one it is named after): { groupId, paneId } */
  const [renaming, setRenaming] = useState(null);
  useBackHandler(!!contextMenu, () => setContextMenu(null));
  /* Other windows, for "Move to Window N" (read when the menu opens) */
  const [otherWindows, setOtherWindows] = useState([]);
  /* A tab of ANOTHER window dragged over this one: where it would land */
  const [foreignDrop, setForeignDrop] = useState(null);
  const tabsRef = useRef(null);

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

  /* Rename: the tab must still be there and still be named after that pane */
  const renamingLive = !!renaming && tabs.some(t => t.id === renaming.groupId && !t.hidden)
    && memberTabs(state, renaming.groupId)[0]?.id === renaming.paneId;
  useEffect(() => { if (renaming && !renamingLive) setRenaming(null); }, [renaming, renamingLive]);
  const endRename = (paneId, text, how) => {
    setRenaming(null);
    if (text !== null) actions.setTabAlias(paneId, text);
    if (how === 'key') {
      requestAnimationFrame(() => document.querySelector(`[data-pane-id="${paneId}"] .xterm-helper-textarea`)?.focus({ preventScroll: true }));
    }
  };

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
    const plan = await planKeeperClose(members);
    if (!plan) return;
    await endSessions(members, actions.disconnectSession, plan);
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
    setContextMenu({ x: Math.min(e.clientX, window.innerWidth - 200), y: e.clientY, tab });
    if (FEATURES.multiWindow) {
      setOtherWindows([]);
      actions.listWindows().then(list => setOtherWindows(list.filter(w => !w.self)));
    }
  };

  /* ── Other windows ── */
  const moveTo = (groupId, target, opts) => {
    actions.moveTabToWindow(groupId, target, opts).catch((err) => {
      window.alert(`Could not move the tab: ${err.message}`);
    });
  };

  /* Which visible tab index a pointer at clientX lands before */
  const indexAt = (clientX) => {
    const els = tabsRef.current ? [...tabsRef.current.querySelectorAll('.tab:not(.tab-home)')] : [];
    let i = 0;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (clientX > r.left + r.width / 2) i++;
    }
    return i;
  };

  /* Tabs dragged in from another window drop anywhere on this one (the
     window's drag regions excepted). Theirs, not ours: our own drags set
     isLocalDrag() synchronously in dragstart. */
  useEffect(() => {
    if (!FEATURES.multiWindow) return undefined;
    windowInfo();
    const foreign = (e) => !isLocalDrag() && !!e.dataTransfer && [...(e.dataTransfer.types || [])].includes(DRAG_MIME);
    const over = (e) => {
      if (!foreign(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const bar = tabsRef.current?.getBoundingClientRect();
      const onBar = bar && e.clientY >= bar.top - 8 && e.clientY <= bar.bottom + 8;
      setForeignDrop(onBar ? { index: indexAt(e.clientX) } : { index: null });
    };
    const leave = (e) => { if (!e.relatedTarget) setForeignDrop(null); };
    const drop = (e) => {
      if (!foreign(e)) return;
      e.preventDefault();
      setForeignDrop(null);
      let d = null;
      try { d = JSON.parse(e.dataTransfer.getData(DRAG_MIME) || 'null'); } catch (_) { d = null; }
      if (!d || d.kind !== 'tab' || d.windowId == null || d.windowId === selfWindowId()) return;
      const bar = tabsRef.current?.getBoundingClientRect();
      const onBar = bar && e.clientY >= bar.top - 8 && e.clientY <= bar.bottom + 8;
      requestMoveHere({ fromWindowId: d.windowId, tabId: d.tabId, index: onBar ? indexAt(e.clientX) : null })
        ?.catch?.(err => console.error('[windows] drop failed:', err.message));
    };
    const end = () => setForeignDrop(null);
    document.addEventListener('dragover', over);
    document.addEventListener('dragleave', leave);
    document.addEventListener('drop', drop);
    document.addEventListener('dragend', end);
    return () => {
      document.removeEventListener('dragover', over);
      document.removeEventListener('dragleave', leave);
      document.removeEventListener('drop', drop);
      document.removeEventListener('dragend', end);
    };
  }, []);

  /* Our tab drag ended and nobody took it: dropped outside the window (new
     window there) or on another Termilab window that did not accept it */
  const tabDragEnd = (e, tab) => {
    setDrag(null);
    if (!FEATURES.multiWindow || !e.dataTransfer || e.dataTransfer.dropEffect !== 'none') return;
    if (cannotMove(state, tab.id)) return;
    dropTarget().then((where) => {
      if (!where || where.kind === 'self') return;
      moveTo(tab.id, where.kind === 'window' ? where.id : 'new', { x: where.x, y: where.y });
    }).catch(err => console.error('[windows] detach failed:', err.message));
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

  /* The context menu's tab: Rename names its lead pane, as the tab label does */
  const ctxMembers = contextMenu && isTerminalTab(contextMenu.tab) ? memberTabs(state, contextMenu.tab.id) : [];
  const ctxLead = ctxMembers[0] || null;

  return (
    <div
      className={`tab-bar${paneDrag || foreignDrop ? ' tab-bar-dropping' : ''}`}
      onDragOver={barDragOver}
      onDrop={barDrop}
    >
      <div className={`tab-bar-tabs${foreignDrop ? ' tab-bar-foreign-drop' : ''}`} role="tablist" ref={tabsRef}>
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

        {visibleTabs.map((tab, i) => {
          /* A split tab: "first host +N", every pane in the tooltip */
          const members = isTerminalTab(tab) ? memberTabs(state, tab.id) : [tab];
          const { label, title } = groupLabel(members);
          /* Panes where an agent finished and nobody looked yet: a green
             check (or how many, in a split tab). It replaces the bell mark,
             which stays only for plain bells (and visual alerts off). */
          const marked = visualAlerts ? members.filter(m => m.doneAt) : [];
          /* …or is waiting for an answer (a permission prompt): the same
             badge in amber, with a "?" (doneKind 'blocked') */
          const waiting = marked.filter(m => m.doneKind === 'blocked').length;
          const done = marked.length - waiting;
          const notify = !marked.length && members.some(m => m.notify);
          /* The agent state dot: the most urgent pane's (working spins,
             blocked is amber; done is the badge above, idle nothing) */
          const agent = isTerminalTab(tab) ? leadAgent(members) : null;
          const canDrag = FEATURES.splitPanes && isTerminalTab(tab);
          /* A split tab shows its first (top-left) pane's colour */
          const lead = isTerminalTab(tab) ? members[0] : null;
          const color = lead ? tabColor(lead, state.hosts) : null;
          const isActive = tab.id === activeTabId;
          const editing = renamingLive && renaming.groupId === tab.id;
          return (
          <div
            key={tab.id}
            className={`tab ${isActive ? 'active' : ''} ${notify ? 'notify' : ''} ${drag?.kind === 'tab' && tab.id === drag.tabId ? 'dragging' : ''}${color ? ' has-color' : ''}${tab.moving ? ' moving' : ''}${foreignDrop && foreignDrop.index === i ? ' drop-before' : ''}${foreignDrop && foreignDrop.index === visibleTabs.length && i === visibleTabs.length - 1 ? ' drop-after' : ''}`}
            style={color ? { '--tab-color': color } : undefined}
            role="tab"
            aria-selected={tab.id === activeTabId}
            title={title}
            draggable={canDrag && !editing}
            onDragStart={canDrag ? (e) => beginDrag(e, { kind: 'tab', tabId: tab.id, windowId: selfWindowId() }, label) : undefined}
            onDragEnd={canDrag ? (e) => tabDragEnd(e, tab) : undefined}
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
            {editing ? (
              <InlineRename
                className="tab-rename"
                value={cleanAlias(lead.alias)}
                placeholder={lead.label || 'Terminal'}
                ariaLabel={`Name for this ${lead.label || 'terminal'} session`}
                onDone={(text, how) => endRename(lead.id, text, how)}
              />
            ) : (
              <span className="tab-label">{label}</span>
            )}
            {agent && !(agent.state === 'blocked' && waiting > 0) && (
              <AgentDot agent={agent} className="tab-agent-dot" />
            )}
            {waiting > 0 && (
              <span
                className={`tab-done tab-waiting${waiting > 1 ? ' count' : ''}`}
                role="img"
                aria-label={waiting > 1 ? `Waiting for you in ${waiting} panes` : 'Waiting for you'}
                title={agent && agent.state === 'blocked' ? `${agentTooltip(agent)}` : 'An agent is waiting for your input'}
              >
                {waiting > 1 ? waiting : '?'}
              </span>
            )}
            {done > 0 && (
              <span
                className={`tab-done${done > 1 ? ' count' : ''}`}
                role="img"
                aria-label={done > 1 ? `Finished in ${done} panes` : 'Finished'}
                title={done > 1 ? `An agent finished in ${done} panes` : 'An agent finished here'}
              >
                {done > 1 ? done : (
                  <svg viewBox="0 0 12 12" width="9" height="9" aria-hidden="true">
                    <path d="M2.5 6.3l2.3 2.2 4.7-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </span>
            )}
            {isActive && lead && (
              <button
                className={`tab-color-btn${picker ? ' open' : ''}`}
                title={members.length > 1 ? `Color of ${paneName(lead)}` : 'Color'}
                aria-label={`Color of ${paneName(lead)}`}
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
        {!paneDrag && foreignDrop && <span className="tab-bar-drop-hint">Drop to move the tab to this window</span>}
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
          title={`This terminal · ${paneTitle(pickerPane)}`}
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
          {ctxLead && (
            <button className="tab-context-menu-item" onClick={() => setRenaming({ groupId: contextMenu.tab.id, paneId: ctxLead.id })}>
              {ctxMembers.length > 1 ? `Rename ${paneName(ctxLead)}…` : 'Rename…'}
            </button>
          )}
          {ctxLead && (
            <button className="tab-context-menu-item" onClick={() => {
              const mute = !ctxMembers.every(m => m.muted);
              ctxMembers.forEach(m => actions.setTabMuted(m.id, mute));
            }}>
              {ctxMembers.every(m => m.muted) ? 'Unmute Sound' : 'Mute Sound'}
            </button>
          )}
          <button className="tab-context-menu-item" onClick={() => handleCloseTab(contextMenu.tab.id)}>
            Close
          </button>
          {FEATURES.splitPanes && ctxMembers.length > 1 && (
            <button className="tab-context-menu-item" onClick={() => actions.ungroupTab(contextMenu.tab.id)}>
              Move Panes to Separate Tabs
            </button>
          )}
          {FEATURES.multiWindow && (() => {
            const why = cannotMove(state, contextMenu.tab.id);
            return (
              <>
                <div className="tab-context-menu-sep" />
                <button className="tab-context-menu-item" disabled={!!why} title={why || undefined}
                  onClick={() => moveTo(contextMenu.tab.id, 'new')}>
                  Move to New Window
                </button>
                {otherWindows.map(w => (
                  <button key={w.id} className="tab-context-menu-item" disabled={!!why} title={why || undefined}
                    onClick={() => moveTo(contextMenu.tab.id, w.id)}>
                    Move to Window {w.number}
                  </button>
                ))}
                <button className="tab-context-menu-item" onClick={() => actions.newWindow()}>
                  New Window<span className="tab-context-menu-key">Ctrl+Shift+N</span>
                </button>
                <div className="tab-context-menu-sep" />
              </>
            );
          })()}
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
