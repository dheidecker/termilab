import React, { useState, useRef, useCallback, useEffect } from 'react';
import TerminalView from '../Terminal/TerminalView';
import { useApp } from '../../contexts/AppContext';
import './SplitPane.css';

/*
  Layout tree:
  - Leaf:   { type: 'terminal', tabId: 'xxx' }
  - Branch: { type: 'split', direction: 'horizontal'|'vertical', ratio: 0.5, children: [layout, layout] }

  KEY DESIGN: All TerminalViews are rendered in a FLAT list (never unmounted).
  The layout tree only creates empty "slots" with refs. A ResizeObserver tracks
  slot positions and we overlay each terminal on its slot via absolute positioning.
*/

let paneCounter = 0;
function nextPaneId() {
  return `pane-${Date.now()}-${++paneCounter}`;
}

/* Collect all tabIds from a layout tree */
function collectTabIds(node) {
  if (!node) return [];
  if (node.type === 'terminal') return [node.tabId];
  return [...collectTabIds(node.children[0]), ...collectTabIds(node.children[1])];
}

/* ─── Pane Toolbar (hover controls) ─── */
function PaneToolbar({ onSplitH, onSplitV, onClose, canClose }) {
  return (
    <div className="pane-toolbar">
      <button className="pane-toolbar-btn" onClick={onSplitH} title="Split Horizontal">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="12" y1="3" x2="12" y2="21" />
        </svg>
      </button>
      <button className="pane-toolbar-btn" onClick={onSplitV} title="Split Vertical">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="3" y1="12" x2="21" y2="12" />
        </svg>
      </button>
      {canClose && (
        <button className="pane-toolbar-btn close" onClick={onClose} title="Close Pane">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="6" y1="18" x2="18" y2="6" />
          </svg>
        </button>
      )}
    </div>
  );
}

/* ─── Draggable Divider ─── */
function Divider({ direction, onDrag }) {
  const handleMouseDown = (e) => {
    e.preventDefault();
    document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';

    const handleMouseMove = (ev) => onDrag(ev);
    const handleMouseUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  return <div className={`split-divider ${direction}`} onMouseDown={handleMouseDown} />;
}

/* ─── SplitContainer: two children + draggable divider ─── */
function SplitContainer({ direction, initialRatio, onRatioChange, children }) {
  const [ratio, setRatio] = useState(initialRatio || 0.5);
  const containerRef = useRef(null);
  const isH = direction === 'horizontal';

  const handleDrag = useCallback((e) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    let r = isH ? (e.clientX - rect.left) / rect.width : (e.clientY - rect.top) / rect.height;
    r = Math.max(0.15, Math.min(0.85, r));
    setRatio(r);
    onRatioChange?.(r);
  }, [isH, onRatioChange]);

  const first = isH ? { width: `${ratio * 100}%`, height: '100%' } : { height: `${ratio * 100}%`, width: '100%' };
  const second = isH ? { width: `${(1 - ratio) * 100}%`, height: '100%' } : { height: `${(1 - ratio) * 100}%`, width: '100%' };

  return (
    <div ref={containerRef} className={`split-container ${direction}`}>
      <div className="split-child" style={first}>{children[0]}</div>
      <Divider direction={direction} onDrag={handleDrag} />
      <div className="split-child" style={second}>{children[1]}</div>
    </div>
  );
}

/* ─── Main SplitPane Component ─── */
export default function SplitPane({ tab }) {
  const { actions } = useApp();

  const [layout, setLayout] = useState({ type: 'terminal', tabId: tab.id });
  const [paneTabs, setPaneTabs] = useState({});
  const slotRefs = useRef({});
  const rootRef = useRef(null);
  const [slotRects, setSlotRects] = useState({});
  const observerRef = useRef(null);
  const rafRef = useRef(null);

  /* Get a tab object for a pane */
  const getTabForPane = useCallback((tabId) => {
    if (tabId === tab.id) return tab;
    return paneTabs[tabId] || null;
  }, [tab, paneTabs]);

  /* All tab IDs currently in the layout */
  const allTabIds = collectTabIds(layout);

  /* ─── Measure slot positions ─── */
  const measureSlots = useCallback(() => {
    if (!rootRef.current) return;
    const rootRect = rootRef.current.getBoundingClientRect();
    const newRects = {};

    for (const tabId of collectTabIds(layout)) {
      const el = slotRefs.current[tabId];
      if (el) {
        const r = el.getBoundingClientRect();
        newRects[tabId] = {
          top: r.top - rootRect.top,
          left: r.left - rootRect.left,
          width: r.width,
          height: r.height,
        };
      }
    }
    setSlotRects(prev => {
      const prevStr = JSON.stringify(prev);
      const newStr = JSON.stringify(newRects);
      return prevStr === newStr ? prev : newRects;
    });
  }, [layout]);

  /* Observe resize on all slots */
  useEffect(() => {
    if (observerRef.current) observerRef.current.disconnect();

    const ro = new ResizeObserver(() => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(measureSlots);
    });

    observerRef.current = ro;

    if (rootRef.current) ro.observe(rootRef.current);
    for (const tabId of allTabIds) {
      const el = slotRefs.current[tabId];
      if (el) ro.observe(el);
    }

    /* Initial measure */
    requestAnimationFrame(measureSlots);

    return () => ro.disconnect();
  }, [layout, allTabIds.join(','), measureSlots]);

  /* ─── Split a pane ─── */
  const splitPane = useCallback((path, direction) => {
    const newTab = {
      id: nextPaneId(),
      type: 'local-terminal',
      label: 'Terminal',
      sessionId: `local-${Date.now()}`,
    };

    setPaneTabs(prev => ({ ...prev, [newTab.id]: newTab }));
    actions.addTab({ ...newTab, noSwitch: true, hidden: true });

    setLayout(prev => {
      const clone = JSON.parse(JSON.stringify(prev));

      if (path.length === 0) {
        return {
          type: 'split', direction, ratio: 0.5,
          children: [clone, { type: 'terminal', tabId: newTab.id }],
        };
      }

      let node = clone;
      for (let i = 0; i < path.length - 1; i++) node = node.children[path[i]];
      const idx = path[path.length - 1];
      const target = node.children[idx];
      node.children[idx] = {
        type: 'split', direction, ratio: 0.5,
        children: [target, { type: 'terminal', tabId: newTab.id }],
      };
      return clone;
    });
  }, [actions]);

  /* ─── Close a pane ─── */
  const closePane = useCallback((path) => {
    if (path.length === 0) return;
    setLayout(prev => {
      const clone = JSON.parse(JSON.stringify(prev));
      if (path.length === 1) {
        return clone.children[path[0] === 0 ? 1 : 0];
      }
      let gp = clone;
      for (let i = 0; i < path.length - 2; i++) gp = gp.children[path[i]];
      const pi = path[path.length - 2];
      const si = path[path.length - 1] === 0 ? 1 : 0;
      gp.children[pi] = gp.children[pi].children[si];
      return clone;
    });
  }, []);

  /* ─── Build tabId → path map ─── */
  const buildPathMap = (node, path = []) => {
    if (node.type === 'terminal') return { [node.tabId]: path };
    return {
      ...buildPathMap(node.children[0], [...path, 0]),
      ...buildPathMap(node.children[1], [...path, 1]),
    };
  };
  const pathMap = buildPathMap(layout);

  /* ─── Render skeleton (empty slots, NO toolbars) ─── */
  const renderSkeleton = (node, path = []) => {
    if (node.type === 'terminal') {
      return (
        <div className="pane-leaf">
          <div
            className="pane-terminal-slot"
            ref={el => { slotRefs.current[node.tabId] = el; }}
          />
        </div>
      );
    }

    if (node.type === 'split') {
      return (
        <SplitContainer
          direction={node.direction}
          initialRatio={node.ratio}
          onRatioChange={() => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            rafRef.current = requestAnimationFrame(measureSlots);
          }}
        >
          {renderSkeleton(node.children[0], [...path, 0])}
          {renderSkeleton(node.children[1], [...path, 1])}
        </SplitContainer>
      );
    }
    return null;
  };

  const isMultiPane = allTabIds.length > 1;

  return (
    <div className="split-pane-root" ref={rootRef}>
      {/* Skeleton: layout structure with empty slots */}
      <div className="split-skeleton">
        {renderSkeleton(layout)}
      </div>

      {/* Terminal overlay layer: flat list, always mounted */}
      {allTabIds.map(tabId => {
        const paneTab = getTabForPane(tabId);
        const rect = slotRects[tabId];
        const panePath = pathMap[tabId] || [];
        if (!paneTab) return null;

        return (
          <div
            key={tabId}
            className="split-terminal-overlay"
            style={rect ? {
              position: 'absolute',
              top: rect.top,
              left: rect.left,
              width: rect.width,
              height: rect.height,
            } : { position: 'absolute', top: 0, left: 0, width: 0, height: 0, overflow: 'hidden' }}
          >
            <PaneToolbar
              onSplitH={() => splitPane(panePath, 'horizontal')}
              onSplitV={() => splitPane(panePath, 'vertical')}
              onClose={() => closePane(panePath)}
              canClose={isMultiPane}
            />
            <TerminalView tab={paneTab} />
          </div>
        );
      })}
    </div>
  );
}
