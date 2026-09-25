import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../contexts/AppContext';
import {
  ArrowLeftIcon, ArrowRightIcon, ArrowUpIcon, RefreshIcon, SearchIcon, EyeIcon, EyeOffIcon, FolderPlusIcon,
  FilePlusIcon, FolderIcon, FileIcon, FileTextIcon, FileCodeIcon, FileImageIcon, FileArchiveIcon, LinkIcon,
  LaptopIcon, ServerIcon, ChevronDownIcon, TransferIcon, PencilIcon, TrashIcon, CopyIcon, LockIcon,
  ExternalLinkIcon, AlertIcon, CloseIcon, UploadIcon,
} from '../Icons/icons';
import { DistroLogo, distroFor } from '../Icons/distros';
import { hostIconBackground } from '../HostList/hostColor';
import HostPicker from './HostPicker';
import { DeleteDialog, NameDialog, PermissionsDialog } from './dialogs';
import { fsFor, endpointOf, edits as editApi, onSessionClose, pathForFile } from './fsApi';
import {
  baseName, parentPath, isRoot, segments, normalizeTyped, nameProblem, isDirLike,
  formatSize, formatDate, iconKind, kindLabel, isEditable, sortEntries,
} from './paths';

const HIDDEN_KEY = 'termilab.sftp.hidden';
const DRAG_MIME = 'application/x-termilab-sftp';
const readHidden = () => { try { return window.localStorage.getItem(HIDDEN_KEY) === '1'; } catch { return false; } };

const ICONS = {
  folder: FolderIcon, 'folder-link': FolderIcon, link: LinkIcon, image: FileImageIcon, archive: FileArchiveIcon,
  code: FileCodeIcon, text: FileTextIcon, pdf: FileTextIcon, audio: FileIcon, video: FileIcon, exec: FileCodeIcon, file: FileIcon,
};

function EntryIcon({ entry }) {
  const kind = iconKind(entry);
  const Icon = ICONS[kind] || FileIcon;
  return (
    <span className={`sftp-ficon sftp-ficon-${kind}`}>
      <Icon />
      {entry.type === 'symlink' && kind !== 'link' && <LinkIcon className="sftp-ficon-badge" />}
    </span>
  );
}

const COLUMNS = [
  { key: 'name', label: 'Name' },
  { key: 'modifyTime', label: 'Date modified' },
  { key: 'size', label: 'Size' },
  { key: 'kind', label: 'Kind' },
];

/**
 * One side of the SFTP tab: a source (this computer or a saved host), its
 * connection, and a file list with navigation, selection, a context menu,
 * dialogs and drag & drop. Transfers are the parent's (SFTPView): this pane
 * reports what it shows through onInfo and asks for copies through
 * onCopyToOther / onDropInternal / onDropFiles.
 */
export default function FilePane({
  tabId, side, source, onSourceChange, focused, onFocus,
  otherLabel, otherReady, onCopyToOther, onDropInternal, onDropFiles, onDownload, dragRef, onInfo, refreshKey,
  initialPickerOpen = false,
}) {
  const { state, actions } = useApp();
  const { connectSftp, disconnectSession } = actions;
  const host = source?.kind === 'host' ? state.hosts.find(h => h.id === source.hostId) : null;
  const sourceLabel = source?.kind === 'local' ? 'Local' : host ? (host.label || host.hostname) : null;

  const [conn, setConn] = useState({ status: 'idle' });
  const [reconnect, setReconnect] = useState(0);
  const [cwd, setCwd] = useState(null);
  const [home, setHome] = useState(null);
  const [history, setHistory] = useState({ stack: [], index: -1 });
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState(null);
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' });
  const [filter, setFilter] = useState('');
  const [showHidden, setShowHidden] = useState(readHidden);
  const [selected, setSelected] = useState(() => new Set());
  const [anchor, setAnchor] = useState(null);
  const [cursor, setCursor] = useState(null);
  const [editingPath, setEditingPath] = useState(false);
  const [pathText, setPathText] = useState('');
  const [renaming, setRenaming] = useState(null);   // {path, value, error}
  const [menu, setMenu] = useState(null);           // {x, y, entry|null}
  const [dialog, setDialog] = useState(null);       // {type, entries?, busy, error}
  const [pickerOpen, setPickerOpen] = useState(initialPickerOpen);
  const [openEdits, setOpenEdits] = useState([]);   // [{editId, name, remotePath, changed, auto, busy, error, uploadedAt}]
  const [notice, setNotice] = useState(null);
  const [dropDir, setDropDir] = useState(null);
  const dragDepth = useRef(0);
  const listRef = useRef(null);
  const loadSeq = useRef(0);

  const kind = source?.kind === 'local' ? 'local' : 'remote';
  const ready = conn.status === 'ready';
  const endpoint = ready ? (kind === 'local' ? { kind: 'local' } : endpointOf({ kind: 'remote', sessionId: conn.sessionId })) : null;
  const fs = useMemo(() => (endpoint ? fsFor(endpoint) : null), [ready, kind, conn.sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const flash = useCallback((text, tone = 'info', action = null) => {
    setNotice({ text, tone, action, at: Date.now() });
  }, []);
  useEffect(() => {
    if (!notice) return undefined;
    const t = setTimeout(() => setNotice(null), notice.action ? 12000 : notice.tone === 'error' ? 6000 : 3000);
    return () => clearTimeout(t);
  }, [notice]);

  /* ─── Connection ─── */
  useEffect(() => {
    setCwd(null);
    setEntries([]);
    setHistory({ stack: [], index: -1 });
    setSelected(new Set());
    setListError(null);
    if (!source) { setConn({ status: 'idle' }); return undefined; }
    if (source.kind === 'local') { setConn({ status: 'ready' }); return undefined; }
    if (!host) { setConn({ status: 'error', error: 'This host no longer exists.' }); return undefined; }
    let cancelled = false;
    let mine = null;
    setConn({ status: 'connecting' });
    connectSftp(host).then((r) => {
      if (cancelled) { if (r.owned) disconnectSession(r.sessionId); return; }
      mine = r;
      setConn({ status: 'ready', sessionId: r.sessionId, owned: r.owned });
    }, (err) => {
      if (!cancelled) setConn({ status: 'error', error: err?.message || 'Could not connect' });
    });
    return () => {
      cancelled = true;
      /* A moment later, not now: a transfer this tab just cancelled still
         has to delete its .termilab-part over this connection. */
      if (mine?.owned) { const id = mine.sessionId; setTimeout(() => disconnectSession(id), 1500); }
    };
  }, [source?.kind, source?.hostId, host?.id, reconnect, connectSftp, disconnectSession]); // eslint-disable-line react-hooks/exhaustive-deps

  /* The session went away under us (server closed it, or the terminal tab we
     borrowed it from was closed). */
  useEffect(() => {
    if (conn.status !== 'ready' || kind !== 'remote') return undefined;
    return onSessionClose((sid) => {
      if (sid !== conn.sessionId) return;
      if (conn.owned) disconnectSession(sid);
      setConn({ status: 'disconnected', error: conn.owned ? 'The connection was closed.' : 'The terminal session this pane was using was closed.' });
    });
  }, [conn.status, conn.sessionId, conn.owned, kind, disconnectSession]);

  /* Closing a terminal tab disconnects in main without an 'ssh:close' push
     (ssh-service drops its listeners first). The session leaving
     activeSessions is the signal that always arrives. */
  const sessionGone = conn.status === 'ready' && kind === 'remote' && !state.activeSessions[conn.sessionId];
  useEffect(() => {
    if (sessionGone) setConn({ status: 'disconnected', error: conn.owned ? 'The connection was closed.' : 'The terminal session this pane was using was closed.' });
  }, [sessionGone]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ─── Listing ─── */
  const load = useCallback(async (dir, { push = true, keepSelection = false } = {}) => {
    if (!fs) return;
    const seq = ++loadSeq.current;
    setLoading(true);
    setCwd(dir);
    setEditingPath(false);
    setRenaming(null);
    if (!keepSelection) { setSelected(new Set()); setAnchor(null); setCursor(null); }
    if (push) {
      setHistory(h => {
        if (h.stack[h.index] === dir) return h;
        const stack = [...h.stack.slice(0, h.index + 1), dir];
        return { stack, index: stack.length - 1 };
      });
    }
    try {
      const list = await fs.list(dir);
      if (seq !== loadSeq.current) return;
      setEntries(list || []);
      setListError(null);
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setEntries([]);
      setListError(err?.message || 'Could not read this folder.');
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [fs]);

  useEffect(() => {
    if (!fs) return;
    let alive = true;
    fs.home().then((h) => {
      if (!alive) return;
      setHome(h);
      load(h);
    }, (err) => { if (alive) setListError(err?.message || 'Could not find the home folder.'); });
    return () => { alive = false; };
  }, [fs, load]);

  const reload = useCallback(() => { if (cwd) load(cwd, { push: false, keepSelection: true }); }, [cwd, load]);

  useEffect(() => {
    if (refreshKey && refreshKey.dir && refreshKey.dir === cwd) reload();
  }, [refreshKey?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Tell the parent what we show, as primitives it can compare. */
  useEffect(() => {
    onInfo(side, { ready: ready && !!cwd, kind, endpoint, cwd, label: sourceLabel, sessionId: conn.sessionId || null });
  }, [side, ready, kind, cwd, sourceLabel, conn.sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const goBack = () => { if (history.index > 0) { const i = history.index - 1; setHistory(h => ({ ...h, index: i })); load(history.stack[i], { push: false }); } };
  const goForward = () => { if (history.index < history.stack.length - 1) { const i = history.index + 1; setHistory(h => ({ ...h, index: i })); load(history.stack[i], { push: false }); } };
  const goUp = () => { if (cwd && !isRoot(kind, cwd)) load(parentPath(kind, cwd)); };

  /* ─── What is visible ─── */
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const list = entries.filter(e => (showHidden || !e.isHidden) && (!needle || e.name.toLowerCase().includes(needle)));
    return sortEntries(list, sort.key, sort.dir);
  }, [entries, showHidden, filter, sort]);
  const hiddenCount = useMemo(() => entries.filter(e => e.isHidden).length, [entries]);
  const selectedEntries = useMemo(() => visible.filter(e => selected.has(e.path)), [visible, selected]);
  const selectedSize = selectedEntries.reduce((s, e) => s + (isDirLike(e) ? 0 : (e.size || 0)), 0);

  const toggleHidden = () => {
    setShowHidden(v => {
      try { window.localStorage.setItem(HIDDEN_KEY, v ? '0' : '1'); } catch { /* storage blocked */ }
      return !v;
    });
  };

  const sortBy = (key) => setSort(s => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }));

  /* ─── Selection ─── */
  const selectOnly = (idx) => {
    const e = visible[idx];
    if (!e) return;
    setSelected(new Set([e.path]));
    setAnchor(idx);
    setCursor(idx);
  };
  const selectRange = (from, to, add) => {
    const [a, b] = from < to ? [from, to] : [to, from];
    setSelected(prev => {
      const next = add ? new Set(prev) : new Set();
      for (let i = a; i <= b; i++) if (visible[i]) next.add(visible[i].path);
      return next;
    });
    setCursor(to);
  };
  const onRowClick = (e, idx) => {
    onFocus();
    /* Keys go to the list after a click, even if the filter box had focus */
    if (!listRef.current?.contains(document.activeElement)) listRef.current?.focus({ preventScroll: true });
    const mod = e.ctrlKey || e.metaKey;
    if (e.shiftKey && anchor != null) selectRange(anchor, idx, mod);
    else if (mod) {
      const p = visible[idx].path;
      setSelected(prev => { const n = new Set(prev); if (n.has(p)) n.delete(p); else n.add(p); return n; });
      setAnchor(idx);
      setCursor(idx);
    } else selectOnly(idx);
  };

  /* ─── Actions ─── */
  const enter = (entry) => {
    if (isDirLike(entry)) load(entry.path);
    else openEntry(entry);
  };

  /* main refuses to hand programs and scripts from a server to the OS
     ("Refusing to open …", sftp-edit-service): offer to download instead. */
  const refusedOrFlash = (entry, verb, err) => {
    const msg = err?.message || '';
    if (/Refusing to open/.test(msg) && onDownload) {
      flash(`${entry.name} could run as a program, so Termilab will not open it.`, 'error',
        { label: 'Download', run: () => onDownload([entry]) });
    } else flash(`Could not ${verb} ${entry.name}: ${msg}`, 'error');
  };

  const openEntry = async (entry) => {
    try {
      if (kind === 'local') await fs.open(entry.path);
      else {
        flash(`Downloading ${entry.name} to open it…`);
        await fs.open(entry.path, tabId);
        flash(`Opened ${entry.name}`);
      }
    } catch (err) {
      refusedOrFlash(entry, 'open', err);
    }
  };

  const editEntry = async (entry) => {
    if (!fs.edit) return openEntry(entry);
    try {
      flash(`Downloading ${entry.name} to edit it…`);
      const r = await fs.edit(entry.path, tabId);
      setOpenEdits(list => [...list, { editId: r.editId, name: r.name || entry.name, remotePath: entry.path, changed: false, auto: false }]);
      setNotice(null);
    } catch (err) {
      refusedOrFlash(entry, 'edit', err);
    }
  };

  /* One upload per edit at a time. A save while one is in flight asks for
     exactly one more, which sends the file as it is then (main serializes
     too; this keeps "busy" honest and skips the redundant middle uploads). */
  const uploadQueue = useRef(new Map());   // editId -> {again}
  const uploadEdit = useCallback(async (editId) => {
    const q = uploadQueue.current;
    if (q.has(editId)) { q.get(editId).again = true; return; }
    const slot = { again: false };
    q.set(editId, slot);
    setOpenEdits(list => list.map(x => (x.editId === editId ? { ...x, busy: true, error: null } : x)));
    try {
      do {
        slot.again = false;
        await editApi.upload(editId);
      } while (slot.again);
      setOpenEdits(list => list.map(x => (x.editId === editId ? { ...x, busy: false, changed: false, uploadedAt: Date.now() } : x)));
      reload();
    } catch (err) {
      setOpenEdits(list => list.map(x => (x.editId === editId ? { ...x, busy: false, error: err.message } : x)));
    } finally {
      q.delete(editId);
    }
  }, [reload]);

  const stopEdit = (editId) => {
    editApi.stop(editId).catch(() => {});
    setOpenEdits(list => list.filter(x => x.editId !== editId));
  };

  const editsRef = useRef(openEdits);
  editsRef.current = openEdits;
  useEffect(() => editApi.onEvent((ev) => {
    if (ev.owner !== tabId || ev.type !== 'changed') return;
    const mine = editsRef.current.find(x => x.editId === ev.editId);
    if (!mine) return;
    if (mine.auto) uploadEdit(ev.editId);
    else setOpenEdits(list => list.map(x => (x.editId === ev.editId ? { ...x, changed: true, error: null } : x)));
  }), [tabId, uploadEdit]);

  const copyPaths = async (list) => {
    const text = list.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      flash(list.length === 1 ? 'Path copied' : `${list.length} paths copied`);
    } catch {
      flash('Could not copy to the clipboard', 'error');
    }
  };

  const startRename = (entry) => {
    if (!entry) return;
    setRenaming({ path: entry.path, value: entry.name, error: null });
  };
  const commitRename = async () => {
    if (!renaming) return;
    const entry = entries.find(e => e.path === renaming.path);
    const value = renaming.value;
    if (!entry || value === entry.name) { setRenaming(null); return; }
    const problem = nameProblem(kind, value);
    if (problem) { setRenaming(r => ({ ...r, error: problem })); return; }
    try {
      const r = await fs.rename(entry.path, value);
      setRenaming(null);
      await load(cwd, { push: false });
      if (r?.path) setSelected(new Set([r.path]));
    } catch (err) {
      setRenaming(rn => (rn ? { ...rn, error: err.message } : rn));
    }
  };

  const runDialog = async (fn) => {
    setDialog(d => ({ ...d, busy: true, error: null }));
    try {
      await fn();
      setDialog(null);
      reload();
    } catch (err) {
      setDialog(d => (d ? { ...d, busy: false, error: err.message } : d));
      reload();
    }
  };

  const doDelete = () => runDialog(async () => {
    for (const e of dialog.entries) await fs.remove(e.path);
    setSelected(new Set());
  });
  const doCreate = (type, name) => runDialog(async () => {
    const r = type === 'folder' ? await fs.mkdir(cwd, name) : await fs.createFile(cwd, name);
    if (r?.path) setSelected(new Set([r.path]));
  });
  const doChmod = (mode) => runDialog(async () => {
    for (const e of dialog.entries) await fs.chmod(e.path, ((e.mode ?? 0) & 0o7000) | mode);
  });

  const askDelete = (list) => list.length && setDialog({ type: 'delete', entries: list });
  const canChmod = kind === 'remote' || (typeof window !== 'undefined' && window.electronAPI?.platform !== 'win32');

  /* ─── Keyboard ─── */
  const onListKeyDown = (e) => {
    if (renaming || editingPath) return;
    const n = visible.length;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!n) return;
      const cur = cursor == null ? (e.key === 'ArrowDown' ? -1 : n) : cursor;
      const next = Math.max(0, Math.min(n - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)));
      if (e.shiftKey && anchor != null) selectRange(anchor, next, false);
      else selectOnly(next);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      if (n) selectOnly(e.key === 'Home' ? 0 : n - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = selectedEntries.length === 1 ? selectedEntries[0] : visible[cursor];
      if (target) enter(target);
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      goUp();
    } else if (e.key === 'Delete') {
      e.preventDefault();
      askDelete(selectedEntries);
    } else if (e.key === 'F2') {
      e.preventDefault();
      startRename(selectedEntries.length === 1 ? selectedEntries[0] : visible[cursor]);
    } else if (mod && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      setSelected(new Set(visible.map(v => v.path)));
    } else if (e.key === 'Escape') {
      setSelected(new Set());
    }
  };

  useEffect(() => {
    if (cursor == null) return;
    listRef.current?.querySelector(`[data-row="${cursor}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  /* ─── Context menu ─── */
  useEffect(() => {
    if (!menu) return undefined;
    const close = () => setMenu(null);
    const onKey = (e) => { if (e.key === 'Escape') setMenu(null); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', close);
    };
  }, [menu]);

  const openMenu = (e, entry, idx) => {
    e.preventDefault();
    e.stopPropagation();
    onFocus();
    if (entry && !selected.has(entry.path)) selectOnly(idx);
    const x = Math.min(e.clientX, window.innerWidth - 230);
    const y = Math.min(e.clientY, window.innerHeight - (entry ? 400 : 200));
    setMenu({ x, y, entry });
  };

  const menuAction = (fn) => (e) => { e.stopPropagation(); setMenu(null); fn(); };
  const menuTargets = menu?.entry ? (selected.has(menu.entry.path) ? selectedEntries : [menu.entry]) : [];

  /* ─── Drag & drop ─── */
  const onRowDragStart = (e, entry, idx) => {
    let list = selectedEntries;
    if (!selected.has(entry.path)) { selectOnly(idx); list = [entry]; }
    dragRef.current = { side, entries: list };
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData(DRAG_MIME, side);
    e.dataTransfer.setData('text/plain', list.map(x => x.path).join('\n'));
  };
  const onRowDragEnd = () => { dragRef.current = null; };

  const acceptsDrag = (e) => {
    if (!ready || !cwd) return false;
    const types = Array.from(e.dataTransfer?.types || []);
    if (types.includes(DRAG_MIME)) return dragRef.current && dragRef.current.side !== side;
    return types.includes('Files');
  };
  const onListDragOver = (e) => {
    if (!acceptsDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const row = e.target.closest?.('[data-dir]');
    setDropDir(row ? row.getAttribute('data-dir') : cwd);
  };
  const onListDragEnter = (e) => { if (acceptsDrag(e)) dragDepth.current++; };
  const onListDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDropDir(null);
  };
  const onListDrop = (e) => {
    const accept = acceptsDrag(e);
    const target = dropDir || cwd;
    dragDepth.current = 0;
    setDropDir(null);
    if (!accept) return;
    e.preventDefault();
    const types = Array.from(e.dataTransfer.types || []);
    if (types.includes(DRAG_MIME) && dragRef.current) {
      onDropInternal(dragRef.current, target);
      dragRef.current = null;
      return;
    }
    const paths = Array.from(e.dataTransfer.files || []).map(pathForFile).filter(Boolean);
    if (paths.length) onDropFiles(paths, target);
    else flash('Nothing to copy: the dropped items have no path on this computer.', 'error');
  };

  /* ─── Rendering ─── */
  const distro = host ? distroFor(host.os) : null;
  const groupMap = useMemo(() => Object.fromEntries((state.groups || []).map(g => [g.id, g])), [state.groups]);

  const pickSource = (src) => {
    setPickerOpen(false);
    if (src.kind === source?.kind && src.hostId === source?.hostId) { if (conn.status !== 'ready') setReconnect(n => n + 1); return; }
    onSourceChange(src);
  };

  const chip = (
    <button className="sftp-source" onClick={() => setPickerOpen(o => !o)} aria-haspopup="dialog" aria-expanded={pickerOpen} title="Change source">
      <span className={`sftp-source-icon ${source?.kind === 'local' || !host ? 'local' : ''}`} style={host ? { background: hostIconBackground(host, distro, groupMap) } : undefined}>
        {source?.kind === 'local' ? <LaptopIcon /> : distro ? <DistroLogo os={host.os} /> : <ServerIcon />}
      </span>
      <span className="sftp-source-text">
        <span className="sftp-source-label">{sourceLabel || 'Select host'}</span>
        {host && <span className="sftp-source-sub">{host.username}@{host.hostname}</span>}
        {source?.kind === 'local' && <span className="sftp-source-sub">This computer</span>}
      </span>
      <ChevronDownIcon className="sftp-source-chevron" />
    </button>
  );

  const statusBadge = (() => {
    if (conn.status === 'connecting') return <span className="sftp-conn connecting"><span className="sftp-spinner" /> Connecting…</span>;
    if (conn.status === 'ready' && kind === 'remote') return <span className="sftp-conn ready" title={conn.owned ? 'Own SFTP connection' : 'Using the open terminal session'}><span className="sftp-dot" />{conn.owned ? 'Connected' : 'Via terminal'}</span>;
    if (conn.status === 'error' || conn.status === 'disconnected') return <span className="sftp-conn bad"><span className="sftp-dot" />{conn.status === 'error' ? 'Failed' : 'Disconnected'}</span>;
    return null;
  })();

  const renderBody = () => {
    if (!source) {
      return (
        <div className="sftp-pane-picker-full">
          <HostPicker hosts={state.hosts} groups={state.groups} current={null} onPick={pickSource} title="Select a host for this pane" />
        </div>
      );
    }
    if (conn.status === 'connecting') {
      return (
        <div className="sftp-state">
          <span className="sftp-spinner large" />
          <p>Connecting to {sourceLabel}…</p>
          <p className="sftp-dim">If this is the first time, confirm the host key in the dialog.</p>
        </div>
      );
    }
    if (conn.status === 'error' || conn.status === 'disconnected') {
      return (
        <div className="sftp-state sftp-state-error">
          <AlertIcon />
          <p>{conn.status === 'error' ? `Could not connect to ${sourceLabel}` : `${sourceLabel} disconnected`}</p>
          <p className="sftp-dim sftp-state-detail">{conn.error}</p>
          <div className="sftp-state-actions">
            <button className="sftp-btn sftp-btn-primary" onClick={() => setReconnect(n => n + 1)}>Reconnect</button>
            <button className="sftp-btn" onClick={() => setPickerOpen(true)}>Choose another</button>
          </div>
        </div>
      );
    }
    return null;
  };

  const body = renderBody();
  const where = `${sourceLabel}: ${cwd || ''}`;
  const crumbs = cwd ? segments(kind, cwd) : [];

  return (
    <section
      className={`sftp-pane ${focused ? 'focused' : ''}`}
      aria-label={`${side === 'left' ? 'Left' : 'Right'} pane${sourceLabel ? `: ${sourceLabel}` : ''}`}
      onMouseDown={onFocus}
    >
      <header className="sftp-pane-head">
        {chip}
        <div className="sftp-pane-head-right">{statusBadge}</div>
        {pickerOpen && source && (
          <div className="sftp-picker-pop">
            <HostPicker hosts={state.hosts} groups={state.groups} current={source} onPick={pickSource} onClose={() => setPickerOpen(false)} />
          </div>
        )}
      </header>

      {body || (
        <>
          <div className="sftp-toolbar">
            <div className="sftp-nav">
              <button className="sftp-icon-btn" onClick={goBack} disabled={history.index <= 0} aria-label="Back" title="Back"><ArrowLeftIcon /></button>
              <button className="sftp-icon-btn" onClick={goForward} disabled={history.index >= history.stack.length - 1} aria-label="Forward" title="Forward"><ArrowRightIcon /></button>
              <button className="sftp-icon-btn" onClick={goUp} disabled={!cwd || isRoot(kind, cwd)} aria-label="Up one folder" title="Up (Backspace)"><ArrowUpIcon /></button>
              <button className="sftp-icon-btn" onClick={reload} disabled={!cwd} aria-label="Refresh" title="Refresh"><RefreshIcon className={loading ? 'sftp-spin' : ''} /></button>
            </div>
            {editingPath ? (
              <form
                className="sftp-path-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const target = normalizeTyped(kind, pathText, home);
                  if (!target) { flash('Type an absolute path (or ~).', 'error'); return; }
                  load(target);
                }}
              >
                <input
                  className="sftp-path-input"
                  value={pathText}
                  onChange={(e) => setPathText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setEditingPath(false); } }}
                  /* Only a click elsewhere in the app cancels; switching windows keeps the edit */
                  onBlur={() => { if (document.hasFocus()) setEditingPath(false); }}
                  autoFocus
                  spellCheck={false}
                  aria-label="Path"
                />
              </form>
            ) : (
              <div
                className="sftp-crumbs"
                onClick={(e) => { if (e.target === e.currentTarget) { setPathText(cwd || ''); setEditingPath(true); } }}
                title="Click an empty spot to type a path"
              >
                {crumbs.map((c, i) => (
                  <React.Fragment key={c.path}>
                    {i > 1 && <span className="sftp-crumb-sep">/</span>}
                    <button
                      className={`sftp-crumb ${i === crumbs.length - 1 ? 'current' : ''}`}
                      onClick={() => load(c.path)}
                      title={c.path}
                    >
                      {c.label}
                    </button>
                  </React.Fragment>
                ))}
                <button className="sftp-crumb-edit" onClick={() => { setPathText(cwd || ''); setEditingPath(true); }} aria-label="Edit path" title="Edit path">
                  <PencilIcon />
                </button>
              </div>
            )}
          </div>

          <div className="sftp-toolbar sftp-toolbar-2">
            <div className="sftp-filter">
              <SearchIcon />
              <input
                type="text"
                placeholder="Filter"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') setFilter(''); }}
                spellCheck={false}
                aria-label="Filter files"
              />
              {filter && <button className="sftp-filter-clear" onClick={() => setFilter('')} aria-label="Clear filter"><CloseIcon /></button>}
            </div>
            <button className={`sftp-icon-btn ${showHidden ? 'on' : ''}`} onClick={toggleHidden} aria-pressed={showHidden} aria-label="Show hidden files" title={showHidden ? 'Hide hidden files' : 'Show hidden files'}>
              {showHidden ? <EyeIcon /> : <EyeOffIcon />}
            </button>
            <button className="sftp-icon-btn" onClick={() => setDialog({ type: 'new-folder' })} disabled={!cwd} aria-label="New folder" title="New folder"><FolderPlusIcon /></button>
            <button className="sftp-icon-btn" onClick={() => setDialog({ type: 'new-file' })} disabled={!cwd} aria-label="New file" title="New file"><FilePlusIcon /></button>
            <button
              className="sftp-copy-btn"
              onClick={() => onCopyToOther(selectedEntries)}
              disabled={!selectedEntries.length || !otherReady}
              title={otherReady ? `Copy selection to ${otherLabel}` : 'Open something in the other pane first'}
            >
              <TransferIcon />
              <span>Copy to {otherLabel || 'other pane'}</span>
            </button>
          </div>

          {openEdits.length > 0 && (
            <div className="sftp-edits">
              {openEdits.map(ed => (
                <div key={ed.editId} className={`sftp-edit-banner ${ed.changed ? 'changed' : ''} ${ed.error ? 'error' : ''}`} role="status">
                  <PencilIcon />
                  <span className="sftp-edit-text">
                    {ed.error ? <><strong>{ed.name}</strong>: upload failed — {ed.error}</>
                      : ed.busy ? <>Uploading <strong>{ed.name}</strong>…</>
                        : ed.changed ? <><strong>{ed.name}</strong> changed on this computer. Upload it to {sourceLabel}?</>
                          : ed.uploadedAt ? <><strong>{ed.name}</strong> uploaded at {new Date(ed.uploadedAt).toLocaleTimeString()}. {ed.auto ? 'Saving again uploads it.' : 'Save again to update it.'}</>
                            : <>Editing <strong>{ed.name}</strong> in your default app. Save it there and you can upload the changes.</>}
                  </span>
                  <span className="sftp-edit-actions">
                    {(ed.changed || ed.error) && !ed.busy && (
                      <button className="sftp-btn sftp-btn-primary sftp-btn-sm" onClick={() => uploadEdit(ed.editId)}><UploadIcon /> Upload</button>
                    )}
                    <label className="sftp-check" title="Upload every save without asking">
                      <input type="checkbox" checked={ed.auto} onChange={(e) => setOpenEdits(list => list.map(x => (x.editId === ed.editId ? { ...x, auto: e.target.checked } : x)))} />
                      <span>Auto-upload</span>
                    </label>
                    <button className="sftp-icon-btn" onClick={() => stopEdit(ed.editId)} aria-label={`Stop editing ${ed.name}`} title="Stop watching"><CloseIcon /></button>
                  </span>
                </div>
              ))}
            </div>
          )}

          <div
            className={`sftp-list-wrap ${dropDir === cwd ? 'drop-here' : ''}`}
            onDragEnter={onListDragEnter}
            onDragOver={onListDragOver}
            onDragLeave={onListDragLeave}
            onDrop={onListDrop}
          >
            <div className="sftp-cols" role="row">
              {COLUMNS.map(c => (
                <button
                  key={c.key}
                  className={`sftp-col sftp-col-${c.key} ${sort.key === c.key ? 'sorted' : ''}`}
                  onClick={() => sortBy(c.key)}
                  aria-sort={sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                >
                  {c.label}
                  {sort.key === c.key && <ChevronDownIcon className={`sftp-sort ${sort.dir}`} />}
                </button>
              ))}
            </div>
            <div
              className="sftp-list"
              role="grid"
              aria-multiselectable="true"
              aria-label={`Files in ${cwd || ''}`}
              tabIndex={0}
              ref={listRef}
              onKeyDown={onListKeyDown}
              onContextMenu={(e) => openMenu(e, null)}
              onMouseDown={(e) => { if (e.target === e.currentTarget) { setSelected(new Set()); onFocus(); } }}
            >
              {listError ? (
                <div className="sftp-state sftp-state-error">
                  <AlertIcon />
                  <p>{/permission denied/i.test(listError) ? 'Permission denied' : 'Could not open this folder'}</p>
                  <p className="sftp-dim sftp-state-detail">{listError}</p>
                  <div className="sftp-state-actions">
                    <button className="sftp-btn" onClick={goUp} disabled={!cwd || isRoot(kind, cwd)}>Go up</button>
                    {home && <button className="sftp-btn" onClick={() => load(home)}>Home</button>}
                    <button className="sftp-btn sftp-btn-primary" onClick={reload}>Retry</button>
                  </div>
                </div>
              ) : !loading && visible.length === 0 ? (
                <div className="sftp-state">
                  <FolderIcon />
                  <p>{filter ? `Nothing matches “${filter}”` : entries.length ? 'Only hidden files here' : 'This folder is empty'}</p>
                  {!filter && entries.length > 0 && !showHidden && <button className="sftp-link-btn" onClick={toggleHidden}>Show {hiddenCount} hidden</button>}
                  {!filter && entries.length === 0 && <p className="sftp-dim">Drop files here to copy them in.</p>}
                </div>
              ) : visible.map((entry, idx) => {
                const isSel = selected.has(entry.path);
                const dirLike = isDirLike(entry);
                const isRenaming = renaming?.path === entry.path;
                return (
                  <div
                    key={entry.path}
                    role="row"
                    aria-selected={isSel}
                    data-row={idx}
                    data-dir={dirLike ? entry.path : undefined}
                    className={`sftp-row ${isSel ? 'selected' : ''} ${cursor === idx ? 'cursor' : ''} ${entry.isHidden ? 'hidden-file' : ''} ${dropDir === entry.path ? 'drop-target' : ''}`}
                    draggable={!isRenaming}
                    onDragStart={(e) => onRowDragStart(e, entry, idx)}
                    onDragEnd={onRowDragEnd}
                    onClick={(e) => onRowClick(e, idx)}
                    onDoubleClick={() => enter(entry)}
                    onContextMenu={(e) => openMenu(e, entry, idx)}
                  >
                    <span className="sftp-cell sftp-col-name">
                      <EntryIcon entry={entry} />
                      {isRenaming ? (
                        <span className="sftp-rename">
                          <input
                            value={renaming.value}
                            autoFocus
                            onFocus={(e) => {
                              const dot = entry.name.lastIndexOf('.');
                              e.target.setSelectionRange(0, dot > 0 && !dirLike ? dot : entry.name.length);
                            }}
                            onChange={(e) => setRenaming(r => ({ ...r, value: e.target.value, error: null }))}
                            onKeyDown={(e) => {
                              e.stopPropagation();
                              if (e.key === 'Enter') commitRename();
                              if (e.key === 'Escape') { setRenaming(null); listRef.current?.focus(); }
                            }}
                            onBlur={() => { if (document.hasFocus()) setRenaming(null); }}
                            onClick={(e) => e.stopPropagation()}
                            onDoubleClick={(e) => e.stopPropagation()}
                            spellCheck={false}
                            aria-label={`New name for ${entry.name}`}
                          />
                          {renaming.error && <span className="sftp-rename-error" role="alert">{renaming.error}</span>}
                        </span>
                      ) : (
                        <span className="sftp-name" title={entry.name}>{entry.name}</span>
                      )}
                    </span>
                    <span className="sftp-cell sftp-col-modifyTime">{formatDate(entry.modifyTime)}</span>
                    <span className="sftp-cell sftp-col-size">{dirLike ? '—' : formatSize(entry.size)}</span>
                    <span className="sftp-cell sftp-col-kind">{kindLabel(entry)}</span>
                  </div>
                );
              })}
            </div>
            {dropDir && (
              <div className="sftp-drop-hint">
                <TransferIcon /> Copy to {dropDir === cwd ? 'this folder' : `“${baseName(kind, dropDir)}”`}
              </div>
            )}
          </div>

          <footer className="sftp-pane-foot">
            <span>
              {visible.length} item{visible.length === 1 ? '' : 's'}
              {!showHidden && hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ''}
            </span>
            {selectedEntries.length > 0 && (
              <span>{selectedEntries.length} selected{selectedSize ? ` · ${formatSize(selectedSize)}` : ''}</span>
            )}
          </footer>
        </>
      )}

      {notice && (
        <div className={`sftp-notice ${notice.tone}${notice.action ? ' has-action' : ''}`} role="status">
          <span className="sftp-notice-text">{notice.text}</span>
          {notice.action && (
            <button className="sftp-btn sftp-btn-sm" onClick={() => { const run = notice.action.run; setNotice(null); run(); }}>
              {notice.action.label}
            </button>
          )}
        </div>
      )}

      {menu && (
        <div className="sftp-menu" style={{ top: menu.y, left: menu.x }} onMouseDown={(e) => e.stopPropagation()} role="menu">
          {menu.entry ? (
            <>
              <button className="sftp-menu-item" role="menuitem" onClick={menuAction(() => enter(menu.entry))} disabled={menuTargets.length !== 1}>
                {isDirLike(menu.entry) ? <FolderIcon /> : <ExternalLinkIcon />} Open
              </button>
              {kind === 'remote' && isEditable(menu.entry) && (
                <button className="sftp-menu-item" role="menuitem" onClick={menuAction(() => editEntry(menu.entry))} disabled={menuTargets.length !== 1}>
                  <FileTextIcon /> Edit
                </button>
              )}
              <button className="sftp-menu-item" role="menuitem" onClick={menuAction(() => onCopyToOther(menuTargets))} disabled={!otherReady}>
                <TransferIcon /> Copy to {otherLabel || 'other pane'}
              </button>
              <div className="sftp-menu-sep" />
              <button className="sftp-menu-item" role="menuitem" onClick={menuAction(() => startRename(menu.entry))} disabled={menuTargets.length !== 1}>
                <PencilIcon /> Rename<kbd>F2</kbd>
              </button>
              <button className="sftp-menu-item" role="menuitem" onClick={menuAction(() => copyPaths(menuTargets.map(t => t.path)))}>
                <CopyIcon /> Copy path
              </button>
              {canChmod && (
                <button className="sftp-menu-item" role="menuitem" onClick={menuAction(() => setDialog({ type: 'perm', entries: menuTargets }))}>
                  <LockIcon /> Permissions…
                </button>
              )}
              <div className="sftp-menu-sep" />
              <button className="sftp-menu-item" role="menuitem" onClick={menuAction(() => setDialog({ type: 'new-folder' }))}><FolderPlusIcon /> New folder</button>
              <button className="sftp-menu-item" role="menuitem" onClick={menuAction(() => setDialog({ type: 'new-file' }))}><FilePlusIcon /> New file</button>
              <button className="sftp-menu-item" role="menuitem" onClick={menuAction(reload)}><RefreshIcon /> Refresh</button>
              <div className="sftp-menu-sep" />
              <button className="sftp-menu-item danger" role="menuitem" onClick={menuAction(() => askDelete(menuTargets))}>
                <TrashIcon /> {kind === 'remote' ? 'Delete…' : 'Move to Trash…'}<kbd>Del</kbd>
              </button>
            </>
          ) : (
            <>
              <button className="sftp-menu-item" role="menuitem" onClick={menuAction(() => setDialog({ type: 'new-folder' }))} disabled={!cwd}><FolderPlusIcon /> New folder</button>
              <button className="sftp-menu-item" role="menuitem" onClick={menuAction(() => setDialog({ type: 'new-file' }))} disabled={!cwd}><FilePlusIcon /> New file</button>
              <button className="sftp-menu-item" role="menuitem" onClick={menuAction(reload)} disabled={!cwd}><RefreshIcon /> Refresh</button>
              <button className="sftp-menu-item" role="menuitem" onClick={menuAction(() => copyPaths([cwd]))} disabled={!cwd}><CopyIcon /> Copy path</button>
              <button className="sftp-menu-item" role="menuitem" onClick={menuAction(toggleHidden)}>{showHidden ? <EyeOffIcon /> : <EyeIcon />} {showHidden ? 'Hide hidden files' : 'Show hidden files'}</button>
            </>
          )}
        </div>
      )}

      {dialog?.type === 'delete' && (
        <DeleteDialog entries={dialog.entries} remote={kind === 'remote'} where={where} onConfirm={doDelete} onCancel={() => setDialog(null)} busy={dialog.busy} error={dialog.error} />
      )}
      {(dialog?.type === 'new-folder' || dialog?.type === 'new-file') && (
        <NameDialog
          title={dialog.type === 'new-folder' ? 'New folder' : 'New file'}
          label={`Name (in ${cwd})`}
          initial={dialog.type === 'new-folder' ? 'New folder' : 'untitled.txt'}
          confirmLabel="Create"
          icon={dialog.type === 'new-folder' ? <FolderPlusIcon /> : <FilePlusIcon />}
          validate={(v) => nameProblem(kind, v) || (entries.some(e => e.name === v) ? `"${v}" already exists here.` : '')}
          onConfirm={(name) => doCreate(dialog.type === 'new-folder' ? 'folder' : 'file', name)}
          onCancel={() => setDialog(null)}
          busy={dialog.busy}
          error={dialog.error}
        />
      )}
      {dialog?.type === 'perm' && (
        <PermissionsDialog entries={dialog.entries} onConfirm={doChmod} onCancel={() => setDialog(null)} busy={dialog.busy} error={dialog.error} />
      )}
    </section>
  );
}
