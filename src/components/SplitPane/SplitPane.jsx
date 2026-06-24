import React, { useState, useRef, useCallback, useEffect } from 'react';
import TerminalView from '../Terminal/TerminalView';
import { useApp } from '../../contexts/AppContext';
import './SplitPane.css';

/*
  Layout tree structure:
  - Leaf:   { type: 'terminal', tabId: 'xxx' }
  - Branch: { type: 'split', direction: 'horizontal'|'vertical', ratio: 0.5, children: [layout, layout] }
*/

/* Generate a unique pane id */
let paneCounter = 0;
function nextPaneId() {
  return `pane-${Date.now()}-${++paneCounter}`;
}

/* Create a new local terminal tab for a split pane */
function createPaneTab() {
  const id = nextPaneId();
  return {
    id,
    type: 'local-terminal',
    label: 'Local Terminal',
    sessionId: `local-${id}`,
  };
}

/* ─── Split Toolbar (appears on hover) ─── */
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
  const dragging = useRef(false);

  const handleMouseDown = (e) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';

    const handleMouseMove = (e) => {
      if (dragging.current) onDrag(e);
    };
    const handleMouseUp = () => {
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  return (
    <div
      className={`split-divider ${direction}`}
      onMouseDown={handleMouseDown}
    />
  );
}

/* ─── Recursive SplitPane ─── */
export default function SplitPane({ tab, layout: externalLayout, onLayoutChange }) {
  /* If no external layout control, manage internally */
  const [internalLayout, setInternalLayout] = useState({
    type: 'terminal',
    tabId: tab.id,
  });

  const layout = externalLayout || internalLayout;
  const setLayout = onLayoutChange || setInternalLayout;
  const { actions } = useApp();

  /* Track extra pane tabs created by splits */
  const [paneTabs, setPaneTabs] = useState({});
  const containerRef = useRef(null);

  /* Get or create a tab for a pane */
  const getTabForPane = useCallback((tabId) => {
    if (tabId === tab.id) return tab;
    return paneTabs[tabId] || null;
  }, [tab, paneTabs]);

  /* Split a terminal pane */
  const splitPane = useCallback((path, direction) => {
    const newTab = createPaneTab();

    /* Add the new pane tab to internal tracking */
    setPaneTabs(prev => ({ ...prev, [newTab.id]: newTab }));

    /* Add tab to global state — noSwitch prevents tab switching, hidden keeps it out of tab bar */
    actions.addTab({ ...newTab, noSwitch: true, hidden: true });

    setLayout(prev => {
      const clone = JSON.parse(JSON.stringify(prev));

      if (path.length === 0) {
        /* Split the root */
        return {
          type: 'split',
          direction,
          ratio: 0.5,
          children: [clone, { type: 'terminal', tabId: newTab.id }],
        };
      }

      /* Navigate to the target node */
      let node = clone;
      for (let i = 0; i < path.length - 1; i++) {
        node = node.children[path[i]];
      }
      const idx = path[path.length - 1];
      const target = node.children[idx];

      node.children[idx] = {
        type: 'split',
        direction,
        ratio: 0.5,
        children: [target, { type: 'terminal', tabId: newTab.id }],
      };

      return clone;
    });
  }, [setLayout, actions]);

  /* Close a pane — replace parent split with sibling */
  const closePane = useCallback((path) => {
    if (path.length === 0) return; /* Can't close the root */

    setLayout(prev => {
      const clone = JSON.parse(JSON.stringify(prev));

      if (path.length === 1) {
        /* Parent is root */
        const siblingIdx = path[0] === 0 ? 1 : 0;
        return clone.children[siblingIdx];
      }

      /* Navigate to grandparent */
      let grandparent = clone;
      for (let i = 0; i < path.length - 2; i++) {
        grandparent = grandparent.children[path[i]];
      }
      const parentIdx = path[path.length - 2];
      const parent = grandparent.children[parentIdx];
      const siblingIdx = path[path.length - 1] === 0 ? 1 : 0;
      grandparent.children[parentIdx] = parent.children[siblingIdx];

      return clone;
    });
  }, [setLayout]);

  /* Resize handler */
  const handleDividerDrag = useCallback((path, direction, e) => {
    if (!containerRef.current) return;

    setLayout(prev => {
      const clone = JSON.parse(JSON.stringify(prev));
      let node = clone;
      for (const idx of path) {
        node = node.children ? node.children[idx] : node;
      }
      /* Actually we need the split node, not the child */
      let splitNode = clone;
      for (let i = 0; i < path.length; i++) {
        splitNode = splitNode;
        break;
      }
      return clone;
    });
  }, [setLayout]);

  /* Render layout recursively */
  const renderLayout = (node, path = []) => {
    if (node.type === 'terminal') {
      const paneTab = getTabForPane(node.tabId);
      if (!paneTab) return <div className="pane-empty">Terminal not found</div>;

      const isRoot = path.length === 0;

      return (
        <div className="pane-leaf">
          <PaneToolbar
            onSplitH={() => splitPane(path, 'horizontal')}
            onSplitV={() => splitPane(path, 'vertical')}
            onClose={() => closePane(path)}
            canClose={!isRoot}
          />
          <div className="pane-terminal-container">
            <TerminalView tab={paneTab} />
          </div>
        </div>
      );
    }

    if (node.type === 'split') {
      const { direction, ratio, children } = node;
      const isHorizontal = direction === 'horizontal';

      return (
        <SplitContainer
          direction={direction}
          initialRatio={ratio}
          onRatioChange={(newRatio) => {
            setLayout(prev => {
              const clone = JSON.parse(JSON.stringify(prev));
              let target = clone;
              for (const idx of path) {
                target = target.children[idx];
              }
              /* If path is empty, target is clone itself */
              if (path.length === 0) {
                clone.ratio = newRatio;
              } else {
                target.ratio = newRatio;
              }
              return clone;
            });
          }}
        >
          {renderLayout(children[0], [...path, 0])}
          {renderLayout(children[1], [...path, 1])}
        </SplitContainer>
      );
    }

    return null;
  };

  return (
    <div className="split-pane-root" ref={containerRef}>
      {renderLayout(layout)}
    </div>
  );
}

/* ─── SplitContainer handles the actual split rendering and resize ─── */
function SplitContainer({ direction, initialRatio, onRatioChange, children }) {
  const [ratio, setRatio] = useState(initialRatio || 0.5);
  const containerRef = useRef(null);
  const isHorizontal = direction === 'horizontal';

  const handleDrag = useCallback((e) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();

    let newRatio;
    if (isHorizontal) {
      newRatio = (e.clientX - rect.left) / rect.width;
    } else {
      newRatio = (e.clientY - rect.top) / rect.height;
    }

    newRatio = Math.max(0.15, Math.min(0.85, newRatio));
    setRatio(newRatio);
    onRatioChange?.(newRatio);
  }, [isHorizontal, onRatioChange]);

  const firstStyle = isHorizontal
    ? { width: `${ratio * 100}%`, height: '100%' }
    : { height: `${ratio * 100}%`, width: '100%' };

  const secondStyle = isHorizontal
    ? { width: `${(1 - ratio) * 100}%`, height: '100%' }
    : { height: `${(1 - ratio) * 100}%`, width: '100%' };

  return (
    <div
      ref={containerRef}
      className={`split-container ${direction}`}
    >
      <div className="split-child" style={firstStyle}>
        {children[0]}
      </div>
      <Divider direction={direction} onDrag={handleDrag} />
      <div className="split-child" style={secondStyle}>
        {children[1]}
      </div>
    </div>
  );
}
