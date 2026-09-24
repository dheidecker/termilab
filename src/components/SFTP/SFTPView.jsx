import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../../contexts/AppContext';
import FilePane from './FilePane';
import TransferQueue from './TransferQueue';
import { ConflictDialog } from './dialogs';
import { fsFor, transfers, edits as editApi } from './fsApi';
import { joinPath, baseName } from './paths';
import './SFTP.css';

const SPLIT_KEY = 'termilab.sftp.split';
const CONCURRENCY = 3;
const readSplit = () => {
  try {
    const v = Number(window.localStorage.getItem(SPLIT_KEY));
    return v >= 0.2 && v <= 0.8 ? v : 0.5;
  } catch { return 0.5; }
};
let seq = 0;
const newId = () => `tr-${Date.now().toString(36)}-${(seq++).toString(36)}`;
const other = (side) => (side === 'left' ? 'right' : 'left');

/**
 * An SFTP tab: two panes side by side with a draggable divider, and the
 * transfer queue underneath. Everything that crosses panes lives here: the
 * queue (CONCURRENCY at a time), conflict questions, and refreshing the pane
 * a transfer landed in. Closing the tab unmounts this: running transfers are
 * cancelled, the tab's temp files (open/edit) deleted, and each pane closes
 * the connection it opened.
 */
export default function SFTPView({ tab }) {
  const { state, actions } = useApp();
  const { updateTab } = actions;
  const panes = tab.panes || { left: { kind: 'local' }, right: null };

  const [split, setSplit] = useState(readSplit);
  const [focused, setFocused] = useState(panes.right ? 'right' : 'left');
  const [info, setInfo] = useState({ left: null, right: null });
  const [queue, setQueue] = useState([]);
  const [queueOpen, setQueueOpen] = useState(true);
  const [conflict, setConflict] = useState(null);
  const [refresh, setRefresh] = useState({ left: null, right: null });
  const dragRef = useRef(null);
  const bodyRef = useRef(null);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const infoRef = useRef(info);
  infoRef.current = info;

  /* Tab label follows the right pane (where the host usually is). */
  const labelFor = useCallback((p) => {
    if (!p) return null;
    if (p.kind === 'local') return 'Local';
    const h = state.hosts.find(x => x.id === p.hostId);
    return h ? (h.label || h.hostname) : null;
  }, [state.hosts]);
  useEffect(() => {
    const host = labelFor(panes.right?.kind === 'host' ? panes.right : panes.left?.kind === 'host' ? panes.left : null);
    const label = host ? `SFTP · ${host}` : 'SFTP';
    if (label !== tab.label) updateTab({ id: tab.id, label });
  }, [panes.left?.hostId, panes.right?.hostId, labelFor]); // eslint-disable-line react-hooks/exhaustive-deps

  const setSource = (side, src) => updateTab({ id: tab.id, panes: { ...panes, [side]: src } });

  const onInfo = useCallback((side, next) => {
    setInfo(prev => {
      const cur = prev[side];
      if (cur && cur.ready === next.ready && cur.cwd === next.cwd && cur.label === next.label
        && cur.kind === next.kind && cur.sessionId === next.sessionId) return prev;
      return { ...prev, [side]: next };
    });
  }, []);

  /* ─── Divider ─── */
  const startResize = (e) => {
    e.preventDefault();
    const rect = bodyRef.current.getBoundingClientRect();
    const move = (ev) => {
      const r = Math.max(0.2, Math.min(0.8, (ev.clientX - rect.left) / rect.width));
      setSplit(r);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('sftp-resizing');
      setSplit(r => { try { window.localStorage.setItem(SPLIT_KEY, String(r)); } catch { /* blocked */ } return r; });
    };
    document.body.classList.add('sftp-resizing');
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  const onDividerKey = (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      setSplit(r => Math.max(0.2, Math.min(0.8, r + (e.key === 'ArrowLeft' ? -0.05 : 0.05))));
    }
  };

  /* ─── Enqueue (with conflict questions) ─── */
  const askConflict = (entry, existing, where, remaining) => new Promise((resolve) => {
    setConflict({ entry, existing, where, remaining, resolve });
  });

  /**
   * from/to: {endpoint, kind, label}. Each top-level entry that already
   * exists in toDir is asked about (unless "apply to all" was ticked).
   */
  const enqueue = useCallback(async (from, entries, to, toDir, toSide) => {
    if (!entries.length || !from?.endpoint || !to?.endpoint) return;
    const toFs = fsFor(to.endpoint);
    let applyAll = null;
    const items = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      let decision;
      let existing = null;
      try { existing = await toFs.stat(joinPath(to.kind, toDir, e.name)); } catch { existing = null; }
      if (existing) {
        if (applyAll) decision = applyAll;
        else {
          const rest = entries.slice(i + 1).length;
          const { choice, all } = await askConflict(e, existing, `${to.label}: ${toDir}`, rest);
          decision = choice;
          if (all) applyAll = choice;
        }
        if (decision === 'skip') continue;
      }
      items.push({
        id: newId(),
        name: e.name,
        isDir: e.type === 'directory',
        src: from.endpoint,
        srcPath: e.path,
        dst: to.endpoint,
        dstDir: toDir,
        toSide,
        conflict: decision,
        fromLabel: from.label,
        toLabel: to.label,
        state: 'queued',
        transferred: 0,
        total: e.type === 'directory' ? 0 : (e.size || 0),
      });
    }
    setConflict(null);
    if (items.length) {
      setQueue(q => [...q, ...items]);
      setQueueOpen(true);
    }
  }, []);

  const copyToOther = (fromSide, entries) => {
    const from = infoRef.current[fromSide];
    const to = infoRef.current[other(fromSide)];
    if (!to?.ready) return;
    enqueue(from, entries, to, to.cwd, other(fromSide));
  };
  const dropInternal = (toSide, drag, targetDir) => {
    const from = infoRef.current[drag.side];
    const to = infoRef.current[toSide];
    if (!from?.ready || !to?.ready) return;
    enqueue(from, drag.entries, to, targetDir, toSide);
  };
  const dropFiles = async (toSide, paths, targetDir) => {
    const to = infoRef.current[toSide];
    if (!to?.ready) return;
    const local = { endpoint: { kind: 'local' }, kind: 'local', label: 'Local' };
    const lfs = fsFor(local.endpoint);
    const entries = [];
    for (const p of paths) {
      try {
        const st = await lfs.stat(p);
        if (st) entries.push({ ...st, name: st.name || baseName('local', p), path: p });
      } catch { /* vanished */ }
    }
    enqueue(local, entries, to, targetDir, toSide);
  };

  /* ─── Scheduler ─── */
  const patch = useCallback((id, fields) => {
    setQueue(q => q.map(it => (it.id === id ? { ...it, ...(typeof fields === 'function' ? fields(it) : fields) } : it)));
  }, []);

  useEffect(() => {
    const running = queue.filter(i => i.state === 'running').length;
    const waiting = queue.filter(i => i.state === 'queued');
    if (running >= CONCURRENCY || !waiting.length) return;
    for (const item of waiting.slice(0, CONCURRENCY - running)) {
      patch(item.id, { state: 'running', startedAt: Date.now(), lastAt: Date.now(), lastBytes: 0, speed: 0 });
      transfers.start(item.id, {
        src: item.src, srcPath: item.srcPath, dst: item.dst, dstDir: item.dstDir, conflict: item.conflict,
      }).then((res) => {
        patch(item.id, (it) => ({ state: 'done', endedAt: Date.now(), bytes: res?.bytes, files: res?.files ?? it.files, transferred: it.total || res?.bytes || 0 }));
        setRefresh(r => ({ ...r, [item.toSide]: { dir: item.dstDir, n: (r[item.toSide]?.n || 0) + 1 } }));
      }, (err) => {
        const cancelled = queueRef.current.find(i => i.id === item.id)?.cancelRequested || /cancelled/i.test(err?.message || '');
        patch(item.id, { state: cancelled ? 'cancelled' : 'error', error: cancelled ? null : (err?.message || 'Failed'), endedAt: Date.now() });
        if (!cancelled) setRefresh(r => ({ ...r, [item.toSide]: { dir: item.dstDir, n: (r[item.toSide]?.n || 0) + 1 } }));
      });
    }
  }, [queue, patch]);

  /* Progress from main (or the mock), for this tab's items only. */
  useEffect(() => transfers.onProgress((p) => {
    if (!queueRef.current.some(i => i.id === p.id)) return;
    patch(p.id, (it) => {
      if (it.state !== 'running') return {};
      const now = Date.now();
      const dt = (now - (it.lastAt || now)) / 1000;
      let speed = it.speed || 0;
      if (dt > 0.05) {
        const inst = Math.max(0, (p.transferred - (it.lastBytes || 0)) / dt);
        speed = speed ? speed * 0.7 + inst * 0.3 : inst;
      }
      return {
        transferred: p.transferred, total: p.total, files: p.files, filesDone: p.filesDone,
        speed, lastAt: dt > 0.05 ? now : it.lastAt, lastBytes: dt > 0.05 ? p.transferred : it.lastBytes,
      };
    });
  }), [patch]);

  const cancel = (id) => {
    const item = queueRef.current.find(i => i.id === id);
    if (!item) return;
    if (item.state === 'queued') { patch(id, { state: 'cancelled' }); return; }
    patch(id, { cancelRequested: true });
    transfers.cancel(id).catch(() => {});
  };
  const retry = (id) => patch(id, { state: 'queued', error: null, transferred: 0, cancelRequested: false, speed: 0 });
  const retryFailed = () => setQueue(q => q.map(i => (i.state === 'error' ? { ...i, state: 'queued', error: null, transferred: 0, speed: 0 } : i)));
  const clearDone = () => setQueue(q => q.filter(i => i.state === 'queued' || i.state === 'running'));

  /* Tab closed: stop what runs, drop temp copies. Panes close their own connections. */
  useEffect(() => () => {
    for (const i of queueRef.current) if (i.state === 'running') transfers.cancel(i.id).catch(() => {});
    editApi.cleanup(tab.id).catch(() => {});
  }, [tab.id]);

  const paneProps = (side) => ({
    tabId: tab.id,
    side,
    source: panes[side],
    onSourceChange: (src) => setSource(side, src),
    focused: focused === side,
    onFocus: () => setFocused(side),
    otherLabel: info[other(side)]?.label,
    otherReady: !!info[other(side)]?.ready,
    onCopyToOther: (entries) => copyToOther(side, entries),
    onDropInternal: (drag, dir) => dropInternal(side, drag, dir),
    onDropFiles: (paths, dir) => dropFiles(side, paths, dir),
    dragRef,
    onInfo,
    refreshKey: refresh[side],
  });

  return (
    <div className="sftp-view">
      <div className="sftp-body" ref={bodyRef}>
        <div className="sftp-slot" style={{ flex: `${split} 1 0` }}>
          <FilePane {...paneProps('left')} />
        </div>
        <div
          className="sftp-divider"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panes"
          aria-valuenow={Math.round(split * 100)}
          aria-valuemin={20}
          aria-valuemax={80}
          tabIndex={0}
          onMouseDown={startResize}
          onKeyDown={onDividerKey}
          onDoubleClick={() => setSplit(0.5)}
        />
        <div className="sftp-slot" style={{ flex: `${1 - split} 1 0` }}>
          <FilePane {...paneProps('right')} />
        </div>
      </div>
      <TransferQueue
        items={queue}
        open={queueOpen}
        onToggle={() => setQueueOpen(o => !o)}
        onCancel={cancel}
        onRetry={retry}
        onRetryFailed={retryFailed}
        onClearDone={clearDone}
      />
      {conflict && (
        <ConflictDialog
          entry={conflict.entry}
          existing={conflict.existing}
          where={conflict.where}
          remaining={conflict.remaining}
          onDecide={(choice, all) => { const r = conflict.resolve; setConflict(null); r({ choice, all }); }}
        />
      )}
    </div>
  );
}
