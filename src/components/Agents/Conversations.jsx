import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../../contexts/AppContext';
import { showToast } from '../Keeper/toast';
import './Conversations.css';

/*
 * Sessions dock → "Conversations": Claude Code conversations on the host of
 * the focused terminal (or "This computer" for a local one / none), newest
 * first, from main's claude-history service (an SSH host: one bounded exec on
 * that tab's own connection, cached 60 s there). Click: a NEW tab to that
 * host (or a local terminal) that runs `cd <project> && claude --resume <id>`
 * (the normal connect path, so with the keeper on it gets its own kept
 * session). Right-click: Resume here (typed into the focused terminal WITHOUT
 * Enter, the user confirms), Copy session id, Show project path.
 *
 * Privacy: nothing about conversations is persisted or synced. Only whether
 * the section is collapsed goes to localStorage.
 *
 * Rendered INSIDE the dock's <ul> (it returns <li>s): two lists with flex:1
 * would split the height.
 */
const OPEN_KEY = 'termilab.agentsDock.conversations';
const FIRST = 8;

export const MOCK_CONVERSATIONS = [
  { id: '0b6f3c1e-1d2a-4c55-9a51-3f0f7c1d2e01', project: '/home/demo/Proyectos/terminal', projectName: 'terminal', mtime: Date.now() - 12 * 60e3, preview: 'Add a Conversations section to the Sessions dock', title: null, command: "cd '/home/demo/Proyectos/terminal' && claude --resume 0b6f3c1e-1d2a-4c55-9a51-3f0f7c1d2e01" },
  { id: '7c1a9e44-5b3d-4f0e-8d21-6a0b2c3d4e02', project: '/home/demo/Proyectos/api server', projectName: 'api server', mtime: Date.now() - 2 * 3600e3, preview: 'Why does the sync cursor go backwards after a restore?', title: 'Sync cursor bug', command: "cd '/home/demo/Proyectos/api server' && claude --resume 7c1a9e44-5b3d-4f0e-8d21-6a0b2c3d4e02" },
  { id: '91d2e3f4-a5b6-47c8-9d0e-1f2a3b4c5d03', project: '/home/demo', projectName: 'demo', mtime: Date.now() - 26 * 3600e3, preview: '/init', title: null, command: "cd '/home/demo' && claude --resume 91d2e3f4-a5b6-47c8-9d0e-1f2a3b4c5d03" },
  { id: 'a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c04', project: '/home/demo/Proyectos/terminal', projectName: 'terminal', mtime: Date.now() - 9 * 86400e3, preview: 'Review the packaging permissions gate before 1.17', title: null, command: "cd '/home/demo/Proyectos/terminal' && claude --resume a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c04" },
];

export function ago(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 60) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

function readOpen() {
  try { return window.localStorage.getItem(OPEN_KEY) !== '0'; } catch { return true; }
}

const historyApi = () => (typeof window !== 'undefined' && window.electronAPI && window.electronAPI.claudeHistory) || null;

async function copyText(text) {
  const c = window.electronAPI && window.electronAPI.clipboard;
  if (c && typeof c.writeText === 'function') return c.writeText(text);
  return navigator.clipboard.writeText(text);
}

/**
 * focusRow: the dock row of this window's focused terminal (or null).
 * now: the dock's clock (ticks every 5 s).
 */
export default function Conversations({ focusRow, now }) {
  const { state, actions } = useApp();
  const { connectToHost, openLocalTerminal, typeInTab } = actions;
  const [open, setOpen] = useState(readOpen);
  const [all, setAll] = useState(false);
  const [menu, setMenu] = useState(null); // { x, y, id }
  const [data, setData] = useState({ key: null, rows: [], loading: false, error: null, found: true });

  /* Whose conversations: the focused terminal's host, else this computer */
  const focusTab = focusRow ? state.tabs.find(t => t.id === focusRow.tabId) : null;
  const ssh = focusTab && focusTab.type !== 'local-terminal';
  const target = ssh
    ? { kind: 'ssh', key: `ssh:${focusTab.hostId || focusRow.host}`, sessionId: focusTab.sessionId && !focusTab.connecting ? focusTab.sessionId : null, label: focusRow.host }
    : { kind: 'local', key: 'local', sessionId: null, label: 'This computer' };

  const reqRef = useRef(0);
  const load = useCallback(async (t, fresh) => {
    const n = ++reqRef.current;
    setData(d => ({ ...d, key: t.key, loading: true, error: null, rows: d.key === t.key ? d.rows : [] }));
    try {
      let res;
      const h = historyApi();
      if (!h) res = { rows: MOCK_CONVERSATIONS, found: true };
      else if (t.kind === 'ssh' && !t.sessionId) throw new Error('Connect this terminal to list its conversations');
      else res = await h.list(t.kind === 'ssh' ? { kind: 'ssh', sessionId: t.sessionId } : { kind: 'local' }, { fresh });
      if (n !== reqRef.current) return;
      setData({ key: t.key, rows: res.rows || [], loading: false, error: null, found: res.found !== false });
    } catch (err) {
      if (n !== reqRef.current) return;
      setData({ key: t.key, rows: [], loading: false, error: (err && err.message) || 'Could not list them', found: true });
    }
  }, []);

  /* On open and whenever the target changes (main caches 60 s per host) */
  const loadKey = `${target.key}|${target.sessionId || ''}`;
  const targetRef = useRef(target);
  targetRef.current = target;
  useEffect(() => {
    if (open) load(targetRef.current, false);
  }, [open, loadKey, load]);

  useEffect(() => {
    if (!menu) return undefined;
    const close = () => setMenu(null);
    const esc = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('click', close);
    document.addEventListener('keydown', esc);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('blur', close);
    };
  }, [menu]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    try { window.localStorage.setItem(OPEN_KEY, next ? '1' : '0'); } catch { /* storage blocked */ }
  };

  /* Click: a new tab to the same place, which runs the command */
  const resumeNew = async (row) => {
    if (!row.command) return showToast('That conversation cannot be resumed from here');
    if (!historyApi()) return showToast(`Would run: ${row.command}`);
    try {
      if (target.kind === 'local') {
        const tabId = openLocalTerminal();
        if (tabId) typeInTab(tabId, `${row.command}\r`);
        return;
      }
      const host = focusTab && (state.hosts.find(h => h.id === focusTab.hostId) || focusTab.hostConfig);
      if (!host) return showToast('Its host is no longer saved here');
      const r = await connectToHost(host);
      if (r && r.tabId && r.sessionId) typeInTab(r.tabId, `${row.command}\r`);
    } catch (err) {
      /* The new tab shows why (refused, auth…) */
      console.error('[conversations] resume failed:', err && err.message);
    }
  };

  /* Resume here: typed into the focused terminal, no Enter */
  const hereWhy = !focusTab ? 'No terminal is focused'
    : focusRow.state ? `${focusRow.name || 'An agent'} is running in this terminal`
      : (ssh ? !target.sessionId : !focusTab.ptySessionId) ? 'This terminal is not connected' : null;
  const resumeHere = async (row) => {
    if (hereWhy || !row.command) return;
    if (!historyApi()) return showToast(`Would type: ${row.command}`);
    const ok = await typeInTab(focusTab.id, row.command, { waitMs: 0 });
    if (ok) requestAnimationFrame(() => document.querySelector(`[data-pane-id="${CSS.escape(focusTab.id)}"] .xterm-helper-textarea`)?.focus({ preventScroll: true }));
  };

  const fresh = data.key === target.key;
  const rows = fresh ? data.rows : [];
  const shown = all ? rows : rows.slice(0, FIRST);
  const menuRow = menu ? rows.find(r => r.id === menu.id) || null : null;

  let status = null;
  if (open) {
    if (fresh && data.error) status = data.error;
    else if (!fresh || (data.loading && rows.length === 0)) status = 'Loading…';
    else if (!data.found) status = 'Claude Code has not been used here';
    else if (rows.length === 0) status = 'No conversations';
  }

  return (
    <>
      <li className="agents-dock-group agents-dock-group-bg conv-head">
        <button className="conv-toggle" onClick={toggle} aria-expanded={open}
          title={open ? 'Hide conversations' : 'Show Claude Code conversations'}>
          <span className={`conv-caret${open ? ' open' : ''}`} aria-hidden="true">▸</span>
          <span>Conversations</span>
          <span className="conv-where">· {target.label}</span>
        </button>
        {open && (
          <button className="conv-refresh" onClick={() => load(target, true)} disabled={data.loading}
            title="List them again" aria-label="Refresh conversations">↻</button>
        )}
      </li>
      {status && <li className="agents-dock-empty agents-dock-empty-inline conv-status">{status}</li>}
      {open && shown.map(row => (
        <li key={row.id}>
          <button
            className="agents-dock-row conv-row"
            onClick={() => resumeNew(row)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setMenu({ x: Math.min(e.clientX, window.innerWidth - 200), y: Math.min(e.clientY, window.innerHeight - 130), id: row.id });
            }}
            title={`${row.title ? `${row.title}\n` : ''}${row.preview}\n${row.project}${row.guessed ? ' (path guessed)' : ''}\nClick to resume it in a new tab`}
          >
            <span className="agents-dock-main">
              <span className="agents-dock-name conv-preview">{row.preview}</span>
              <span className="agents-dock-where">
                <span className="agents-dock-where-text">{row.projectName}</span>
              </span>
            </span>
            <span className="agents-dock-side">
              <span className="agents-dock-time">{ago(row.mtime, now)}</span>
            </span>
          </button>
        </li>
      ))}
      {open && rows.length > FIRST && (
        <li>
          <button className="conv-more" onClick={() => setAll(!all)}>
            {all ? 'Show fewer' : `Show ${rows.length - FIRST} more`}
          </button>
        </li>
      )}
      {menuRow && (
        <li className="conv-menu-holder">
          <div className="tab-context-menu agents-dock-menu" style={{ top: menu.y, left: menu.x }}>
            <button className="tab-context-menu-item" onClick={() => { setMenu(null); resumeNew(menuRow); }}>Resume in New Tab</button>
            <button className="tab-context-menu-item" disabled={!!hereWhy} title={hereWhy || 'Types the command in the focused terminal; press Enter to run it'}
              onClick={() => { setMenu(null); resumeHere(menuRow); }}>Resume Here</button>
            <div className="tab-context-menu-sep" />
            <button className="tab-context-menu-item" onClick={() => {
              setMenu(null);
              copyText(menuRow.id).then(() => showToast('Session id copied'), () => showToast('Could not copy'));
            }}>Copy Session ID</button>
            <button className="tab-context-menu-item" onClick={() => {
              setMenu(null);
              showToast(`${menuRow.project}${menuRow.guessed ? ' (guessed from the folder name)' : ''}`, 6000);
            }}>Show Project Path</button>
          </div>
        </li>
      )}
    </>
  );
}
