import React, { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import TerminalView from '../Terminal/TerminalView';
import { useApp } from '../../contexts/AppContext';
import { FEATURES } from '../../platform';
import {
  layoutOf, collectIds, isTerminalTab, groupOf, focusedPaneOf, zoneFromPoint,
} from './layoutTree';
import { useDrag, beginDrag, setDrag } from './dragState';
import { confirmCloseSessions, endSessions } from './sessions';
import './SplitPane.css';

/*
  Desktop terminals. ONE flat layer for every terminal session of the app,
  whatever tab it belongs to, so a session moved between tabs or panes keeps
  its TerminalView (same xterm, scrollback, selection, search) and its SSH or
  pty session: nothing unmounts, only the overlay's position changes.

  The open tab's layout (AppContext `layouts`, see layoutTree.js) renders as an
  empty skeleton of slots; each of its sessions is overlaid on its slot. The
  others are display:none, as whole tabs were before. xterm's own
  ResizeObserver refits to the new slot and sends the resize to the session.

  Keep the layer's children in a stable order: React moving a DOM node that
  holds an xterm blurs it. (Android still renders SplitPane.jsx per tab.)
*/

const sig = (node) => `${node.type === 'split' ? node.direction : 't'}:${collectIds(node).join(',')}`;

/* ─── Divider + two children; the ratio goes to the tree on mouseup ─── */
function SplitContainer({ direction, ratio: initial, onCommit, children }) {
  const [ratio, setRatio] = useState(initial || 0.5);
  const ratioRef = useRef(ratio);
  const containerRef = useRef(null);
  const isH = direction === 'horizontal';
  useEffect(() => { setRatio(initial || 0.5); ratioRef.current = initial || 0.5; }, [initial]);

  const onMouseDown = (e) => {
    e.preventDefault();
    document.body.style.cursor = isH ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    const move = (ev) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      let r = isH ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
      r = Math.max(0.15, Math.min(0.85, r));
      ratioRef.current = r;
      setRatio(r);
    };
    const up = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      onCommit(ratioRef.current);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const first = isH ? { width: `${ratio * 100}%`, height: '100%' } : { height: `${ratio * 100}%`, width: '100%' };
  const second = isH ? { width: `${(1 - ratio) * 100}%`, height: '100%' } : { height: `${(1 - ratio) * 100}%`, width: '100%' };
  return (
    <div ref={containerRef} className={`split-container ${direction}`}>
      <div className="split-child" style={first}>{children[0]}</div>
      <div className={`split-divider ${direction}`} onMouseDown={onMouseDown} />
      <div className="split-child" style={second}>{children[1]}</div>
    </div>
  );
}

function Skeleton({ node, path, slotRef, onRatio }) {
  if (node.type === 'terminal') {
    return (
      <div className="pane-leaf">
        <div className="pane-terminal-slot" data-pane-slot={node.tabId} ref={el => slotRef(node.tabId, el)} />
      </div>
    );
  }
  /* Keyed by content: after a move or swap the split below remounts with the
     tree's ratio instead of keeping another split's local one */
  return (
    <SplitContainer direction={node.direction} ratio={node.ratio} onCommit={(r) => onRatio(path, r)}>
      {node.children.map((c, i) => (
        <Skeleton key={sig(c)} node={c} path={[...path, i]} slotRef={slotRef} onRatio={onRatio} />
      ))}
    </SplitContainer>
  );
}

/* ─── Icons ─── */
const Svg = ({ children }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
);
const SplitHIcon = () => <Svg><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="12" y1="3" x2="12" y2="21" /></Svg>;
const SplitVIcon = () => <Svg><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="3" y1="12" x2="21" y2="12" /></Svg>;
const CloseSvg = () => <Svg><line x1="6" y1="6" x2="18" y2="18" /><line x1="6" y1="18" x2="18" y2="6" /></Svg>;
const DetachIcon = () => <Svg><rect x="3" y="7" width="14" height="14" rx="2" /><polyline points="14 3 21 3 21 10" /><line x1="21" y1="3" x2="12" y2="12" /></Svg>;
const GripIcon = () => (
  <svg viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">
    {[3, 8, 13].map(y => <React.Fragment key={y}><circle cx="3" cy={y} r="1.3" /><circle cx="7" cy={y} r="1.3" /></React.Fragment>)}
  </svg>
);

const paneStatus = (tab) => (tab.error ? 'error' : tab.connecting || !tab.sessionId ? 'connecting' : 'connected');

/* Single-pane tab: the floating split buttons, as before */
function PaneToolbar({ onSplitH, onSplitV }) {
  return (
    <div className="pane-toolbar">
      <button className="pane-toolbar-btn" onClick={onSplitH} title="Split Right"><SplitHIcon /></button>
      <button className="pane-toolbar-btn" onClick={onSplitV} title="Split Down"><SplitVIcon /></button>
    </div>
  );
}

/* Multi-pane tab: which host this is, a drag handle, and the pane's actions */
function PaneHeader({ tab, focused, onSplitH, onSplitV, onDetach, onClose, onMenu }) {
  return (
    <div className={`pane-header${focused ? ' focused' : ''}`} onContextMenu={onMenu}>
      <div
        className="pane-handle"
        draggable
        title={`Drag ${tab.label} onto another pane, or onto the tab bar for its own tab`}
        onDragStart={(e) => beginDrag(e, { kind: 'pane', paneId: tab.id }, tab.label)}
        onDragEnd={() => setDrag(null)}
      >
        <span className="pane-grip"><GripIcon /></span>
        <span className={`pane-status ${paneStatus(tab)}`} />
        <span className="pane-title">{tab.label || 'Terminal'}</span>
      </div>
      <div className="pane-header-actions">
        <button className="pane-toolbar-btn" onClick={onSplitH} title="Split Right"><SplitHIcon /></button>
        <button className="pane-toolbar-btn" onClick={onSplitV} title="Split Down"><SplitVIcon /></button>
        <button className="pane-toolbar-btn" onClick={onDetach} title="Move to New Tab"><DetachIcon /></button>
        <button className="pane-toolbar-btn close" onClick={onClose} title="Close Pane"><CloseSvg /></button>
      </div>
    </div>
  );
}

const ZONE_TEXT = { left: 'Left', right: 'Right', top: 'Top', bottom: 'Bottom', center: 'Swap' };

export default function SessionStage() {
  const { state, actions } = useApp();
  const { tabs, layouts, activeTabId } = state;
  const { splitPane, dropOnPane, detachPane, focusPane, setPaneRatio, removeTab, disconnectSession } = actions;
  const drag = useDrag();

  const stageRef = useRef(null);
  const slotEls = useRef({});
  const overlayEls = useRef({});
  const [rects, setRects] = useState({});
  const [hover, setHover] = useState(null);   // { paneId, zone } under a drag
  const [menu, setMenu] = useState(null);     // { x, y, paneId, groupId } pane header menu

  /* Every terminal session, in first-seen order (see the note above) */
  const orderRef = useRef([]);
  const termTabs = tabs.filter(isTerminalTab);
  const byId = new Map(termTabs.map(t => [t.id, t]));
  orderRef.current = orderRef.current.filter(id => byId.has(id));
  for (const t of termTabs) if (!orderRef.current.includes(t.id)) orderRef.current.push(t.id);

  const active = byId.get(activeTabId);
  const groupId = active && !active.hidden ? active.id : null;
  const tree = groupId ? layoutOf(layouts, groupId) : null;
  const paneIds = collectIds(tree);
  const multi = paneIds.length > 1;
  const treeKey = tree ? JSON.stringify(tree) : '';
  /* The same without divider ratios: releasing a divider is not a new layout */
  const shapeKey = tree ? JSON.stringify(tree, (k, v) => (k === 'ratio' ? undefined : v)) : '';
  const focusId = groupId ? focusedPaneOf(state, groupId) : null;
  const paneIdsRef = useRef(paneIds);
  paneIdsRef.current = paneIds;

  /* ─── Slot positions, relative to the stage ─── */
  const measure = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const base = stage.getBoundingClientRect();
    const next = {};
    for (const id of paneIdsRef.current) {
      const el = slotEls.current[id];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      next[id] = { top: r.top - base.top, left: r.left - base.left, width: r.width, height: r.height };
    }
    setRects(prev => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, []);

  /* Before paint, so a moved pane never shows a frame at its old place */
  useLayoutEffect(() => { measure(); }, [treeKey, groupId, measure]);

  useEffect(() => {
    if (!groupId) return undefined;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    });
    if (stageRef.current) ro.observe(stageRef.current);
    for (const id of paneIdsRef.current) if (slotEls.current[id]) ro.observe(slotEls.current[id]);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [treeKey, groupId, measure]);

  const slotRef = useCallback((id, el) => {
    if (el) slotEls.current[id] = el;
    else delete slotEls.current[id];
  }, []);
  const onRatio = useCallback((path, r) => setPaneRatio(groupId, path, r), [setPaneRatio, groupId]);

  /* Keyboard to the focused pane when a tab opens or its layout changes
     (a drop, a split, a closed pane). Not on a plain click in a pane, nor on
     a divider drag: either may leave an open search box, which must keep
     the focus. */
  const focusIdRef = useRef(focusId);
  focusIdRef.current = focusId;
  useEffect(() => {
    if (!groupId) return undefined;
    const raf = requestAnimationFrame(() => {
      const ta = overlayEls.current[focusIdRef.current]?.querySelector('.xterm-helper-textarea');
      if (ta && document.activeElement !== ta) ta.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [groupId, shapeKey]);

  /* Header menu: only for a pane of the tab on screen. Another tab opened
     (Ctrl+Tab) or the pane gone from the layout closes it, or its actions
     would act on a pane that is not on screen. */
  const menuLive = !!menu && menu.groupId === groupId && paneIds.includes(menu.paneId) && byId.has(menu.paneId);
  useEffect(() => { if (menu && !menuLive) setMenu(null); }, [menu, menuLive]);

  /* Header menu: any click elsewhere or Esc closes it */
  useEffect(() => {
    if (!menu) return undefined;
    const close = () => setMenu(null);
    const esc = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('click', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', esc); };
  }, [menu]);

  useEffect(() => { if (!drag) setHover(null); }, [drag]);

  const closePane = async (tab) => {
    if (!confirmCloseSessions([tab], tab.label || 'Terminal')) return;
    await endSessions([tab], disconnectSession);
    removeTab(tab.id);
  };

  /* ─── Drop layer: only while a drag this tab can take is in flight ─── */
  const dragSourceGroup = drag ? (drag.kind === 'tab' ? drag.tabId : groupOf(state, drag.paneId)) : null;
  const canDrop = !!(drag && groupId && (drag.kind === 'pane' ? byId.has(drag.paneId) : drag.tabId !== groupId && byId.has(drag.tabId)));
  const allowCenter = drag?.kind === 'pane' && dragSourceGroup === groupId;
  const dragLabel = drag ? (byId.get(drag.kind === 'tab' ? drag.tabId : drag.paneId)?.label || 'Terminal') : '';
  const zoneAt = (e) => zoneFromPoint(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY, allowCenter);
  const isSelf = (id) => drag?.kind === 'pane' && drag.paneId === id;

  return (
    <div className="session-stage" ref={stageRef} style={{ display: groupId ? 'flex' : 'none' }}>
      <div className="split-skeleton">
        {tree && <Skeleton key={`${groupId}|${sig(tree)}`} node={tree} path={[]} slotRef={slotRef} onRatio={onRatio} />}
      </div>

      {orderRef.current.map(id => {
        const tab = byId.get(id);
        const rect = paneIds.includes(id) ? rects[id] : null;
        const style = rect
          ? { position: 'absolute', top: rect.top, left: rect.left, width: rect.width, height: rect.height }
          : { display: 'none' };
        const shown = !!rect;
        return (
          <div
            key={id}
            ref={el => { if (el) overlayEls.current[id] = el; else delete overlayEls.current[id]; }}
            className={`split-terminal-overlay${shown && multi ? ' multi' : ''}${shown && multi && id === focusId ? ' focused' : ''}`}
            data-pane-id={id}
            style={style}
            onFocus={shown && multi ? () => focusPane(groupId, id) : undefined}
            onMouseDownCapture={shown && multi ? () => focusPane(groupId, id) : undefined}
          >
            {FEATURES.splitPanes && shown && (multi ? (
              <PaneHeader
                tab={tab}
                focused={id === focusId}
                onSplitH={() => splitPane(groupId, id, 'horizontal')}
                onSplitV={() => splitPane(groupId, id, 'vertical')}
                onDetach={() => detachPane(id)}
                onClose={() => closePane(tab)}
                onMenu={(e) => { e.preventDefault(); setMenu({ x: Math.min(e.clientX, window.innerWidth - 190), y: e.clientY, paneId: id, groupId }); }}
              />
            ) : (
              <PaneToolbar
                onSplitH={() => splitPane(groupId, id, 'horizontal')}
                onSplitV={() => splitPane(groupId, id, 'vertical')}
              />
            ))}
            <TerminalView tab={tab} />
          </div>
        );
      })}

      {canDrop && (
        <div className="pane-drop-layer">
          {paneIds.map(id => rects[id] && (
            <div
              key={id}
              className={`pane-drop-target${isSelf(id) ? ' self' : ''}`}
              data-pane-drop={id}
              style={{ top: rects[id].top, left: rects[id].left, width: rects[id].width, height: rects[id].height }}
              onDragOver={(e) => {
                if (isSelf(id)) return;   /* onto itself: nothing to do, no drop */
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const zone = zoneAt(e);
                setHover(h => (h && h.paneId === id && h.zone === zone ? h : { paneId: id, zone }));
              }}
              onDragLeave={(e) => {
                if (e.currentTarget.contains(e.relatedTarget)) return;
                setHover(h => (h && h.paneId === id ? null : h));
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (!isSelf(id)) dropOnPane(drag, groupId, id, zoneAt(e));
                setHover(null);
                setDrag(null);
              }}
            >
              {hover && hover.paneId === id && (
                <div className={`pane-drop-zone zone-${hover.zone}`}>
                  <span className="pane-drop-chip">{dragLabel} · {ZONE_TEXT[hover.zone]}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {menuLive && (
        <div className="tab-context-menu pane-context-menu" style={{ top: menu.y, left: menu.x }}>
          <button className="tab-context-menu-item" onClick={() => detachPane(menu.paneId)}>Move to New Tab</button>
          <button className="tab-context-menu-item" onClick={() => splitPane(groupId, menu.paneId, 'horizontal')}>Split Right</button>
          <button className="tab-context-menu-item" onClick={() => splitPane(groupId, menu.paneId, 'vertical')}>Split Down</button>
          <button className="tab-context-menu-item danger" onClick={() => closePane(byId.get(menu.paneId))}>Close Pane</button>
        </div>
      )}
    </div>
  );
}
