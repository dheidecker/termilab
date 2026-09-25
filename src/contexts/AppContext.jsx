import React, { createContext, useContext, useReducer, useEffect, useCallback, useRef } from 'react';
import { normalizeSyncStatus } from '../components/Sync/helpers';
import { mockConnect } from '../components/SFTP/fsApi';
import * as Layout from '../components/SplitPane/layoutTree';
import { connectTab, markAbandoned } from '../components/SplitPane/sessions';

const AppContext = createContext(null);

/* ── Mock data for browser dev without Electron ── */
/* Enough of them to fill the Hosts grid, with one duplicate endpoint (4/14)
   so the duplicate banner shows up in browser dev mode too. */
const MOCK_HOSTS = [
  { id: '1', label: 'Production Server', hostname: '192.168.1.100', port: 22, username: 'root', os: 'ubuntu', authType: 'password', groupId: 'g1', createdAt: '2026-06-08T09:00:00.000Z', tags: ['prod'] },
  { id: '2', label: 'Staging Server', hostname: '192.168.1.101', port: 22, username: 'deploy', os: 'debian', authType: 'key', keyId: 'k1', groupId: 'g1', createdAt: '2026-02-15T09:00:00.000Z', tags: ['staging'] },
  { id: '3', label: 'Database Server', hostname: '10.0.0.50', port: 2222, username: 'admin', os: 'rocky', authType: 'password', groupId: 'g2', createdAt: '2026-07-22T09:00:00.000Z', tags: ['db'] },
  { id: '4', label: 'Dev Machine', hostname: 'dev.local', port: 22, username: 'derek', authType: 'key', keyId: 'k1', groupId: null, createdAt: '2026-03-02T09:00:00.000Z', tags: [] },
  { id: '5', label: 'Edge Proxy', hostname: '192.168.1.110', port: 22, username: 'root', authType: 'password', groupId: 'g1', createdAt: '2026-08-09T09:00:00.000Z', tags: ['prod'] },
  { id: '6', label: 'Replica 1', hostname: '10.0.0.51', port: 22, username: 'postgres', authType: 'key', keyId: 'k1', groupId: 'g2', createdAt: '2026-04-16T09:00:00.000Z', tags: ['db'] },
  { id: '7', label: 'Home NAS', hostname: 'nas.home.arpa', port: 22, username: 'admin', authType: 'password', groupId: 'g3', createdAt: '2026-09-23T09:00:00.000Z', tags: [] },
  { id: '8', label: 'Raspberry Pi', hostname: '192.168.0.42', port: 22, username: 'pi', os: 'raspbian', authType: 'password', groupId: 'g3', createdAt: '2026-05-03T09:00:00.000Z', tags: [] },
  { id: '9', label: 'Build Runner', hostname: 'ci-runner-01.internal', port: 22, username: 'ci', os: 'fedora', authType: 'key', keyId: 'k1', groupId: null, createdAt: '2026-01-10T09:00:00.000Z', tags: ['ci'] },
  { id: '10', label: 'Bastion', hostname: 'bastion.example.com', port: 2200, username: 'derek', authType: 'key', keyId: 'k1', groupId: null, createdAt: '2026-06-17T09:00:00.000Z', tags: [] },
  { id: '11', label: 'Mail Relay', hostname: 'mx1.example.com', port: 22, username: 'root', authType: 'password', groupId: null, createdAt: '2026-02-24T09:00:00.000Z', tags: [] },
  { id: '12', label: 'Monitoring', hostname: 'grafana.internal', port: 22, username: 'ops', authType: 'key', keyId: 'k1', groupId: null, createdAt: '2026-07-04T09:00:00.000Z', tags: ['ops'] },
  { id: '13', label: 'Backup Box', hostname: 'backup.home.arpa', port: 22, username: 'borg', authType: 'key', keyId: 'k1', groupId: 'g3', createdAt: '2026-03-11T09:00:00.000Z', tags: [] },
  { id: '14', label: 'dev.local', hostname: 'dev.local', port: 22, username: 'derek', authType: 'password', groupId: null, createdAt: '2026-08-18T09:00:00.000Z', tags: [] },
];

const MOCK_GROUPS = [
  { id: 'g1', label: 'Web Servers', color: '#58a6ff' },
  { id: 'g2', label: 'Databases', color: '#3fb950' },
  { id: 'g3', label: 'Home Lab', color: 'hsl(28, 70%, 55%)' },
  { id: 'g4', label: 'Clients', color: 'hsl(280, 45%, 60%)' },
];

const MOCK_SNIPPETS = [
  { id: 's1', name: 'System Update', command: 'sudo apt update && sudo apt upgrade -y', description: 'Update system packages' },
  { id: 's2', name: 'Disk Usage', command: 'df -h', description: 'Check disk space' },
  { id: 's3', name: 'Docker Status', command: 'docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"', description: 'List running containers' },
];

const MOCK_KEYS = [
  { id: 'k1', label: 'Personal Key', type: 'ED25519', fingerprint: 'SHA256:xXxXxXxXxXxXxXxXxXxXxXxXx', publicKey: 'ssh-ed25519 AAAA...', createdAt: '2024-01-15' },
];

/* Current rule shape (see components/PortForwarding/rules.js). The status
   map shows every card state in browser dev mode; 'pf4' has no host, like a
   rule migrated from the old UI. */
const MOCK_PORT_FORWARDS = [
  { id: 'pf1', label: 'Postgres on db', type: 'local', hostId: '3', bindAddress: '127.0.0.1', localPort: 5433, destHost: 'localhost', destPort: 5432, createdAt: '2026-08-02T10:00:00.000Z' },
  { id: 'pf2', label: 'Grafana', type: 'local', hostId: '12', bindAddress: '127.0.0.1', localPort: 3000, destHost: 'grafana.internal', destPort: 3000, createdAt: '2026-08-20T10:00:00.000Z' },
  { id: 'pf3', label: 'Share dev server', type: 'remote', hostId: '10', bindAddress: '127.0.0.1', localPort: 9000, destHost: 'localhost', destPort: 5173, createdAt: '2026-09-01T10:00:00.000Z' },
  { id: 'pf4', label: 'Old tunnel', type: 'local', hostId: null, bindAddress: '127.0.0.1', localPort: 8080, destHost: 'localhost', destPort: 80, createdAt: '2025-12-01T10:00:00.000Z' },
  { id: 'pf5', label: 'Browse via bastion', type: 'dynamic', hostId: '10', bindAddress: '127.0.0.1', localPort: 1080, destHost: '', destPort: null, createdAt: '2026-09-10T10:00:00.000Z' },
];
const MOCK_PORT_FORWARD_STATUS = {
  pf1: { state: 'running' },
  pf2: { state: 'error', error: 'Port 3000 on 127.0.0.1 is already in use on this computer.' },
  pf5: { state: 'starting' },
};

/* Known hosts and connection logs are local-only collections, loaded on
   demand by their sections (not in INIT_DATA). Browser dev mode gets these. */
const mockAgo = (days, h = 0, m = 0) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};
const MOCK_KNOWN_HOSTS = [
  { id: 'kh1', host: '192.168.1.100', port: 22, keyType: 'ssh-ed25519', key: '', fingerprint: 'SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8', addedAt: mockAgo(40, 9, 12) },
  { id: 'kh2', host: '192.168.1.101', port: 22, keyType: 'ecdsa-sha2-nistp256', key: '', fingerprint: 'SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM', addedAt: mockAgo(33, 17, 40) },
  { id: 'kh3', host: '10.0.0.50', port: 2222, keyType: 'ssh-rsa', key: '', fingerprint: 'SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s', addedAt: mockAgo(20, 11, 5) },
  { id: 'kh4', host: 'bastion.example.com', port: 2200, keyType: 'ssh-ed25519', key: '', fingerprint: 'SHA256:Ht8FUuJ3oyI9JwbZq6nH8Xv6Zo0zFfJmN0cS1Rw2kTg', addedAt: mockAgo(12, 8, 30) },
  { id: 'kh5', host: 'github.com', port: 22, keyType: 'ssh-ed25519', key: '', fingerprint: 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU', addedAt: mockAgo(9, 14, 2) },
  { id: 'kh6', host: 'nas.home.arpa', port: 22, keyType: 'ssh-ed25519', key: '', fingerprint: 'SHA256:Kq1d0kU7l3mFz6qk2dZ3Yb9cD1oH0y4c2m4Rj8bQx1E', addedAt: mockAgo(3, 20, 45) },
  { id: 'kh7', host: 'dev.local', port: 22, keyType: 'ssh-ed25519', key: '', fingerprint: 'SHA256:4b9xQ7w1mYh2Vf3kZt8pR0sL6cN5dJ1eG2aU9oI3yT0', addedAt: mockAgo(1, 10, 0) },
];
const MOCK_CONNECTION_LOGS = [
  { id: 'l1', type: 'ssh', hostId: '1', label: 'Production Server', hostname: '192.168.1.100', port: 22, username: 'root', os: 'ubuntu', email: 'derek@example.com', deviceName: 'derek-laptop', startedAt: mockAgo(9, 12, 30), endedAt: mockAgo(2, 14, 43) },
  { id: 'l2', type: 'local', hostId: null, label: 'Local Terminal', email: 'derek@example.com', deviceName: 'derek-laptop', startedAt: mockAgo(3, 9, 5), endedAt: mockAgo(3, 9, 48) },
  { id: 'l3', type: 'ssh', hostId: null, label: 'ops@203.0.113.7', hostname: '203.0.113.7', port: 2222, username: 'ops', os: 'debian', email: 'derek@example.com', deviceName: 'derek-laptop', startedAt: mockAgo(2, 16, 10), endedAt: mockAgo(2, 16, 52) },
  { id: 'l4', type: 'ssh', hostId: '3', label: 'Database Server', hostname: '10.0.0.50', port: 2222, username: 'admin', os: 'rocky', email: 'derek@example.com', deviceName: 'derek-laptop', startedAt: mockAgo(1, 8, 0), endedAt: mockAgo(1, 11, 21) },
  { id: 'l5', type: 'sftp', hostId: '4', label: 'Dev Machine', hostname: 'dev.local', port: 22, username: 'derek', email: '', deviceName: 'derek-desktop', startedAt: mockAgo(0, 10, 2), endedAt: mockAgo(0, 10, 15) },
  { id: 'l6', type: 'ssh', hostId: '8', label: 'Raspberry Pi', hostname: '192.168.0.42', port: 22, username: 'pi', os: 'raspbian', email: 'derek@example.com', deviceName: 'derek-laptop', startedAt: mockAgo(0, 11, 30) },
];

const MOCK_SETTINGS = {
  terminal: { fontSize: 14, fontFamily: 'JetBrains Mono', cursorStyle: 'block', scrollback: 5000 },
  appearance: { theme: 'dark', accentColor: '#58a6ff' },
  ssh: { defaultPort: 22, keepAliveInterval: 30 },
  general: { autoConnect: false, restoreTabs: false },
};

/* ── Helper to check Electron API ── */
const api = () => window.electronAPI;
const hasApi = () => typeof window !== 'undefined' && !!window.electronAPI;

/* What ssh:connect gets for a saved host: the same for a terminal and for an
   SFTP pane's own connection. main resolves keyId to the private key and runs
   the same host-key verification either way. */
function buildConnectConfig(host) {
  const config = {
    host: host.hostname,
    port: host.port || 22,
    username: host.username,
    /* For the Logs section only: main keeps hostId if it is a saved host */
    hostId: host.id,
    label: host.label || host.hostname,
  };
  if (host.authType === 'password') config.password = host.password || '';
  if (host.authType === 'key' && host.keyId) config.keyId = host.keyId;
  if (host.authType === 'key' && host.privateKey) config.privateKey = host.privateKey;
  return config;
}

/* ── Sync bridge ──
   Built by the main process; absent in the browser and in any build whose main
   process predates sync. Callers get a rejected promise with a readable message
   instead of "cannot read property of undefined". */
const syncApi = () => window.electronAPI?.sync;
const noSync = () => Promise.reject(new Error('Sync is not available in this build'));

/* ── Initial State ── */
const initialState = {
  hosts: [],
  groups: [],
  snippets: [],
  keys: [],
  portForwards: [],
  /* ruleId -> { state: 'starting'|'running'|'error', error? }. In memory in
     main; a rule missing here is stopped. Never persisted. */
  portForwardStatus: {},
  settings: MOCK_SETTINGS,
  activeSessions: {},     // sessionId -> { hostId, host, status }
  tabs: [],               // { id, type:'terminal'|'sftp', label, sessionId?, hostId?, hidden?, color?, alias? (both session-only, never saved) }
  activeTabId: null,
  /* Split panes (desktop), in memory only. groupId -> layout tree, for tabs
     with more than one pane; the other panes are tabs with hidden:true. See
     components/SplitPane/layoutTree.js. */
  layouts: {},
  focusedPane: {},        // groupId -> pane tab id that gets the keyboard
  /* Last visible terminal tab that was active. The home tab (where Snippets
     lives) is never a session, so "Run" targets this one. */
  lastSessionTabId: null,
  activeSection: 'hosts', // home tab section: hosts | keychain | port-forwarding | snippets | known-hosts | logs | settings
  loading: true,
  hostFormOpen: false,
  editingHost: null,
  broadcast: false,
  /* Sync — `available` is false until we have seen window.electronAPI.sync.
     `status` stays null while the first sync.status() is in flight so the UI
     can tell "not signed in" from "we don't know yet". */
  sync: { available: false, loading: true, status: null },
};

/* ── Reducer ── */
const isSessionTab = (t) => !!t && !t.hidden && (t.type === 'terminal' || t.type === 'local-terminal');

/* Keeps lastSessionTabId pointing at an open session tab: follows activeTabId
   when it lands on one, and falls back to the rightmost session tab (or null)
   when the remembered one closes. */
function trackLastSession(state) {
  const active = state.tabs.find(t => t.id === state.activeTabId);
  let next = state.lastSessionTabId;
  /* In a split tab, the pane that has the keyboard */
  if (isSessionTab(active)) next = Layout.focusedPaneOf(state, active.id);
  else if (next && !state.tabs.some(t => t.id === next)) {
    next = [...state.tabs].reverse().find(isSessionTab)?.id ?? null;
  }
  return next === state.lastSessionTabId ? state : { ...state, lastSessionTabId: next };
}

function appReducer(state, action) {
  const next = baseReducer(state, action);
  return next === state ? state : trackLastSession(next);
}

function baseReducer(state, action) {
  switch (action.type) {
    /* ── Data loading ── */
    case 'SET_LOADING':
      return { ...state, loading: action.payload };
    case 'INIT_DATA':
      return { ...state, ...action.payload, loading: false };

    /* ── Sync ── */
    case 'SET_SYNC_AVAILABLE':
      return {
        ...state,
        sync: {
          ...state.sync,
          available: !!action.payload,
          /* No sync bridge means nothing will ever load. Stop waiting. */
          loading: action.payload ? state.sync.loading : false,
        },
      };
    case 'SET_SYNC_STATUS': {
      /* Push events may carry only the fields that changed, so they merge.
         A full sync.status() reply replaces, otherwise a cleared field
         (email after logout) would keep its stale value forever. */
      const base = action.replace ? {} : (state.sync.status || {});
      return {
        ...state,
        sync: {
          ...state.sync,
          loading: false,
          status: normalizeSyncStatus({ ...base, ...(action.payload || {}) }),
        },
      };
    }

    /* ── Hosts ── */
    case 'SET_HOSTS':
      return { ...state, hosts: action.payload };
    case 'ADD_HOST':
      return { ...state, hosts: [...state.hosts, action.payload] };
    case 'UPDATE_HOST':
      return { ...state, hosts: state.hosts.map(h => h.id === action.payload.id ? action.payload : h) };
    case 'DELETE_HOST':
      return { ...state, hosts: state.hosts.filter(h => h.id !== action.payload) };

    /* ── Groups ── */
    case 'SET_GROUPS':
      return { ...state, groups: action.payload };
    case 'ADD_GROUP':
      return { ...state, groups: [...state.groups, action.payload] };
    case 'UPDATE_GROUP':
      return { ...state, groups: state.groups.map(g => g.id === action.payload.id ? action.payload : g) };
    case 'DELETE_GROUP':
      return { ...state, groups: state.groups.filter(g => g.id !== action.payload) };

    /* ── Snippets ── */
    case 'SET_SNIPPETS':
      return { ...state, snippets: action.payload };
    case 'ADD_SNIPPET':
      return { ...state, snippets: [...state.snippets, action.payload] };
    case 'UPDATE_SNIPPET':
      return { ...state, snippets: state.snippets.map(s => s.id === action.payload.id ? action.payload : s) };
    case 'DELETE_SNIPPET':
      return { ...state, snippets: state.snippets.filter(s => s.id !== action.payload) };

    /* ── Keys ── */
    case 'SET_KEYS':
      return { ...state, keys: action.payload };
    case 'ADD_KEY':
      return { ...state, keys: [...state.keys, action.payload] };
    case 'DELETE_KEY':
      return { ...state, keys: state.keys.filter(k => k.id !== action.payload) };

    /* ── Port Forwards ── */
    case 'SET_PORT_FORWARDS':
      return { ...state, portForwards: action.payload };
    case 'ADD_PORT_FORWARD':
      return { ...state, portForwards: [...state.portForwards, action.payload] };
    case 'UPDATE_PORT_FORWARD':
      return { ...state, portForwards: state.portForwards.map(p => p.id === action.payload.id ? action.payload : p) };
    case 'DELETE_PORT_FORWARD':
      return { ...state, portForwards: state.portForwards.filter(p => p.id !== action.payload) };
    case 'SET_PORT_FORWARD_STATUS': {
      /* One push: { ruleId, state, error? }. 'stopped' drops the entry. */
      const { ruleId, state: st, error } = action.payload || {};
      if (!ruleId) return state;
      const next = { ...state.portForwardStatus };
      if (!st || st === 'stopped') delete next[ruleId];
      else next[ruleId] = error ? { state: st, error } : { state: st };
      return { ...state, portForwardStatus: next };
    }
    case 'REPLACE_PORT_FORWARD_STATUS':
      return { ...state, portForwardStatus: action.payload || {} };

    /* ── Settings ── */
    case 'SET_SETTINGS':
      return { ...state, settings: action.payload };

    /* ── Sessions ── */
    case 'ADD_SESSION':
      return { ...state, activeSessions: { ...state.activeSessions, [action.payload.sessionId]: action.payload } };
    case 'REMOVE_SESSION': {
      const s = { ...state.activeSessions };
      delete s[action.payload];
      return { ...state, activeSessions: s };
    }

    /* ── Tabs ── */
    case 'SET_TABS':
      return { ...state, tabs: action.payload };
    case 'ADD_TAB': {
      const newTabs = [...state.tabs, action.payload];
      const newActiveId = action.payload.noSwitch ? state.activeTabId : action.payload.id;
      return { ...state, tabs: newTabs, activeTabId: newActiveId };
    }
    /* payload: a tab id or several (all the panes of a split tab). A pane
       that was the tab's own id hands the tab over to the next pane. */
    case 'REMOVE_TAB': {
      const ids = [].concat(action.payload);
      const result = Layout.removeTabs(state, ids);
      const next = Layout.applyModel(state, result);
      if (next === state) return state;
      if (!next.tabs.some(t => t.id === next.activeTabId) && next.activeTabId !== null) {
        /* The active tab went: its neighbour in the bar (hidden panes skipped) */
        const visible = state.tabs.filter(t => !t.hidden);
        const idx = visible.findIndex(t => t.id === state.activeTabId);
        const remaining = next.tabs.filter(t => !t.hidden);
        next.activeTabId = remaining.length > 0
          ? (remaining[Math.min(Math.max(idx, 0), remaining.length - 1)]?.id ?? null)
          : null;
      }
      return next;
    }
    case 'SET_ACTIVE_TAB': {
      /* A pane of a split tab (Snippets' "Run"): its tab, with that pane focused */
      let id = action.payload;
      let focusedPane = state.focusedPane;
      const target = id ? state.tabs.find(t => t.id === id) : null;
      if (target?.hidden) {
        const g = Layout.groupOf(state, id);
        if (g) { focusedPane = { ...focusedPane, [g]: id }; id = g; }
      }
      /* Opening a split tab clears the bell of every pane in it */
      const members = id ? Layout.collectIds(Layout.layoutOf(state.layouts, id)) : [];
      return {
        ...state,
        activeTabId: id,
        focusedPane,
        tabs: state.tabs.map(t => members.includes(t.id) && t.notify ? { ...t, notify: false } : t),
      };
    }
    case 'TAB_NOTIFY':
      /* A pane of the tab on screen is visible: no bell mark */
      if (Layout.groupOf(state, action.payload) === state.activeTabId) return state;
      return {
        ...state,
        tabs: state.tabs.map(t => t.id === action.payload ? { ...t, notify: true } : t),
      };

    /* ── Split panes (desktop) ── */
    case 'PANE_SPLIT': {
      const { groupId, paneId, newTab, direction } = action.payload;
      return Layout.applyModel(state, Layout.splitWith(state, groupId, paneId, newTab, direction), { groupId, paneId: newTab.id });
    }
    /* drag: { kind:'tab', tabId } | { kind:'pane', paneId }; zone: left|right|top|bottom|center */
    case 'PANE_DROP': {
      const { drag, groupId, paneId, zone } = action.payload;
      const result = drag.kind === 'tab'
        ? Layout.mergeTab(state, drag.tabId, groupId, paneId, zone === 'center' ? 'right' : zone)
        : Layout.movePane(state, drag.paneId, groupId, paneId, zone);
      if (result.model === state) return state;
      /* What was dropped gets the keyboard */
      const dropped = drag.kind === 'tab' ? Layout.focusedPaneOf(state, drag.tabId) : drag.paneId;
      const next = Layout.applyModel(state, result, { groupId: result.renamed[groupId] || groupId, paneId: dropped });
      /* Whatever landed in the tab on screen is visible: no bell mark (as SET_ACTIVE_TAB) */
      const members = next.activeTabId ? Layout.collectIds(Layout.layoutOf(next.layouts, next.activeTabId)) : [];
      if (!next.tabs.some(t => t.notify && members.includes(t.id))) return next;
      return { ...next, tabs: next.tabs.map(t => (t.notify && members.includes(t.id) ? { ...t, notify: false } : t)) };
    }
    case 'PANE_DETACH':
      return Layout.applyModel(state, Layout.detachPane(state, action.payload));
    case 'PANE_UNGROUP':
      return Layout.applyModel(state, Layout.ungroup(state, action.payload));
    case 'PANE_FOCUS': {
      const { groupId, paneId } = action.payload;
      if (state.focusedPane[groupId] === paneId) return state;
      return { ...state, focusedPane: { ...state.focusedPane, [groupId]: paneId } };
    }
    case 'PANE_RATIO': {
      const { groupId, path, ratio } = action.payload;
      const tree = state.layouts[groupId];
      if (!tree) return state;
      return { ...state, layouts: { ...state.layouts, [groupId]: Layout.setRatioAt(tree, path, ratio) } };
    }
    case 'UPDATE_TAB':
      return { ...state, tabs: state.tabs.map(t => t.id === action.payload.id ? { ...t, ...action.payload } : t) };

    /* ── Navigation ── */
    case 'SET_ACTIVE_SECTION':
      return { ...state, activeSection: action.payload };

    /* ── Host form ── */
    case 'OPEN_HOST_FORM':
      return { ...state, hostFormOpen: true, editingHost: action.payload || null, newHostDefaults: action.defaults || null };
    case 'CLOSE_HOST_FORM':
      return { ...state, hostFormOpen: false, editingHost: null, newHostDefaults: null };

    /* ── Broadcast ── */
    case 'TOGGLE_BROADCAST':
      return { ...state, broadcast: !state.broadcast };

    default:
      return state;
  }
}

/* ── Provider ── */
export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(appReducer, initialState);
  /* Latest state for async handlers that must not act on a stale closure. */
  const stateRef = useRef(state);
  stateRef.current = state;

  /* Load initial data */
  useEffect(() => {
    async function loadData() {
      if (hasApi()) {
        try {
          const [
            hosts,
            groups,
            snippets,
            keys,
            forwards,
            settings,
          ] = await Promise.all([
            api().store.getHosts(),
            api().store.getGroups(),
            api().store.getSnippets(),
            api().store.getKeys(),
            api().store.getPortForwards(),
            api().store.getSettings(),
          ]);
          dispatch({
            type: 'INIT_DATA',
            payload: {
              hosts: hosts || [],
              groups: groups || [],
              snippets: snippets || [],
              keys: keys || [],
              portForwards: forwards || [],
              settings: settings || MOCK_SETTINGS,
            },
          });
        } catch (err) {
          console.error('Failed to load data from store:', err);
          dispatch({ type: 'SET_LOADING', payload: false });
        }
      } else {
        /* Browser dev mode – use mock data */
        dispatch({
          type: 'INIT_DATA',
          payload: {
            hosts: MOCK_HOSTS,
            groups: MOCK_GROUPS,
            snippets: MOCK_SNIPPETS,
            keys: MOCK_KEYS,
            portForwards: MOCK_PORT_FORWARDS,
            settings: MOCK_SETTINGS,
          },
        });
        dispatch({ type: 'REPLACE_PORT_FORWARD_STATUS', payload: MOCK_PORT_FORWARD_STATUS });
      }
    }
    loadData();
  }, []);

  const appTheme = state.settings?.appearance?.theme === 'light' ? 'light' : 'dark';
  const accentColor = state.settings?.appearance?.accentColor;

  /**
   * Apply the app theme and accent color as CSS variables on <html>.
   *
   * Both are handled in one effect because both change the same custom
   * properties, and Chromium will not repaint an element whose `transition`
   * covers a property that changed only via a custom-property update — it
   * keeps painting the old color until some unrelated reflow happens. So
   * transitions are suppressed for the duration of the swap (see the
   * .theme-switching rule in index.css), which also avoids the whole UI
   * cross-fading between palettes.
   */
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('theme-switching');
    root.dataset.theme = appTheme;

    const props = ['--accent', '--accent-hover', '--accent-muted', '--accent-subtle'];
    if (!accentColor) {
      /* Fall back to whatever the active theme defines */
      props.forEach(p => root.style.removeProperty(p));
    } else {
      const r = parseInt(accentColor.slice(1, 3), 16);
      const g = parseInt(accentColor.slice(3, 5), 16);
      const b = parseInt(accentColor.slice(5, 7), 16);

      /* amount > 0 lightens toward white, < 0 darkens toward black */
      const shade = (amount) => {
        const mix = (c) => Math.max(0, Math.min(255, Math.round(
          amount >= 0 ? c + (255 - c) * amount : c * (1 + amount)
        )));
        return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
      };

      /* The accent swatches are picked for a dark background, so on light we
         shade them down — otherwise text on a solid accent fill is unreadable. */
      if (appTheme === 'light') {
        root.style.setProperty('--accent', shade(-0.3));
        root.style.setProperty('--accent-hover', shade(-0.5));
      } else {
        root.style.setProperty('--accent', accentColor);
        root.style.setProperty('--accent-hover', shade(0.2));
      }
      root.style.setProperty('--accent-muted', `rgba(${r}, ${g}, ${b}, 0.15)`);
      root.style.setProperty('--accent-subtle', `rgba(${r}, ${g}, ${b}, 0.08)`);
    }

    /* Commit the new colors while transitions are still off */
    void root.offsetHeight;
    const raf = requestAnimationFrame(() => root.classList.remove('theme-switching'));
    return () => cancelAnimationFrame(raf);
  }, [appTheme, accentColor]);

  /**
   * Sync status subscription.
   *
   * The bridge may not exist at all (browser dev mode, or an older main
   * process): every call is optional-chained and the UI falls back to an
   * "unavailable" panel instead of crashing. Status arrives twice — once
   * pulled with sync.status(), then pushed on every change — so nothing here
   * polls.
   */
  useEffect(() => {
    const sync = window.electronAPI?.sync;
    if (!sync || typeof sync.status !== 'function') {
      dispatch({ type: 'SET_SYNC_AVAILABLE', payload: false });
      return undefined;
    }
    dispatch({ type: 'SET_SYNC_AVAILABLE', payload: true });

    let mounted = true;
    Promise.resolve()
      .then(() => sync.status())
      .then(s => { if (mounted) dispatch({ type: 'SET_SYNC_STATUS', payload: s, replace: true }); })
      .catch(err => {
        if (mounted) dispatch({
          type: 'SET_SYNC_STATUS',
          payload: { error: err?.message || 'Could not read sync status' },
          replace: true,
        });
      });

    const listener = sync.onStatus?.(s => dispatch({ type: 'SET_SYNC_STATUS', payload: s }));

    return () => {
      mounted = false;
      /* Call the remover, not the listener. Passing the listener back is
         harmless if the bridge ignores its arguments. */
      sync.removeStatusListener?.(listener);
    };
  }, []);

  /**
   * Port forwarding status. Main keeps running forwards in memory, keyed by
   * rule id: pull the current list once, then follow the pushes. This is the
   * only subscriber; components read state.portForwardStatus.
   */
  useEffect(() => {
    const pf = window.electronAPI?.portForward;
    if (!pf || typeof pf.onStatus !== 'function') return undefined;
    let mounted = true;
    const listener = pf.onStatus((payload) => dispatch({ type: 'SET_PORT_FORWARD_STATUS', payload }));
    Promise.resolve()
      .then(() => pf.status?.())
      .then((list) => {
        if (!mounted || !Array.isArray(list)) return;
        const map = {};
        for (const s of list) {
          if (s && s.ruleId && s.state !== 'stopped') map[s.ruleId] = s.error ? { state: s.state, error: s.error } : { state: s.state };
        }
        dispatch({ type: 'REPLACE_PORT_FORWARD_STATUS', payload: map });
      })
      .catch(() => { /* keep whatever the pushes said */ });
    return () => {
      mounted = false;
      pf.removeStatusListener?.(listener);
    };
  }, []);

  /**
   * A saved host's colour (swatch pickers). Field-level in main, like the OS:
   * `store.setHostColor(hostId, color)` sets ONLY `color` on the host as it is
   * on disk, under the store lock. Never a full-object saveHost from here: a
   * sync pull may have just rewritten hosts.json. Rejects with a readable
   * message for a host sealed by another device (a local save would destroy
   * its sealed remote password); the popover shows it. null = no colour.
   */
  const setHostColor = useCallback(async (hostId, color) => {
    if (!hasApi()) {
      const host = stateRef.current.hosts.find(h => h.id === hostId);
      if (!host) return null;
      const next = { ...host };
      if (color) next.color = color; else delete next.color;
      dispatch({ type: 'UPDATE_HOST', payload: next });
      return next;
    }
    const store = api().store;
    if (typeof store?.setHostColor !== 'function') throw new Error('This build cannot save host colors');
    const saved = await store.setHostColor(hostId, color);
    if (saved && saved.id === hostId) dispatch({ type: 'UPDATE_HOST', payload: saved });
    return saved;
  }, []);

  /* ── Action creators ── */
  const actions = {
    setHostColor,
    /* The colour of ONE terminal (tab/pane), for this session only: four
       terminals of the same host can each get their own. Never persisted and
       never touches the host; `'none'` means "no colour", overriding the host's
       default. See HostList/hostColor.js tabColor(). */
    setTabColor: useCallback(async (tabId, color) => {
      if (!stateRef.current.tabs.some(t => t.id === tabId)) return null;
      dispatch({ type: 'UPDATE_TAB', payload: { id: tabId, color: color || 'none' } });
      return null;
    }, []),

    /* A name for ONE terminal, for this session only ("logs", "deploy"):
       `tab.alias`, shown in place of the host label. Never persisted, never
       touches the host; empty = back to the host label. Lives on the tab, so
       split moves, swaps and detaching keep it (layoutTree only patches
       `hidden`). */
    setTabAlias: useCallback((tabId, alias) => {
      if (!stateRef.current.tabs.some(t => t.id === tabId)) return;
      dispatch({ type: 'UPDATE_TAB', payload: { id: tabId, alias: Layout.cleanAlias(alias) || null } });
    }, []),

    /* Hosts */
    saveHost: useCallback(async (host) => {
      if (hasApi()) {
        const saved = await api().store.saveHost(host);
        if (host.id) dispatch({ type: 'UPDATE_HOST', payload: saved });
        else dispatch({ type: 'ADD_HOST', payload: saved });
        return saved;
      } else {
        const saved = { ...host, id: host.id || crypto.randomUUID() };
        if (host.id) dispatch({ type: 'UPDATE_HOST', payload: saved });
        else dispatch({ type: 'ADD_HOST', payload: saved });
        return saved;
      }
    }, []),

    deleteHost: useCallback(async (id) => {
      if (hasApi()) await api().store.deleteHost(id);
      dispatch({ type: 'DELETE_HOST', payload: id });
    }, []),

    /* Keeps `merged` (the survivor, already combined by the caller) and deletes
       the rest. Save first, delete after: if something fails halfway the worst
       case is a duplicate that is still there, never a host that is gone. The
       deletes propagate to every synced computer as tombstones. */
    mergeHosts: useCallback(async (merged, otherIds) => {
      if (hasApi()) {
        const saved = await api().store.saveHost(merged);
        dispatch({ type: 'UPDATE_HOST', payload: saved });
        for (const id of otherIds) {
          await api().store.deleteHost(id);
          dispatch({ type: 'DELETE_HOST', payload: id });
        }
        return saved;
      }
      dispatch({ type: 'UPDATE_HOST', payload: merged });
      for (const id of otherIds) dispatch({ type: 'DELETE_HOST', payload: id });
      return merged;
    }, []),

    /* Groups */
    saveGroup: useCallback(async (group) => {
      if (hasApi()) {
        const saved = await api().store.saveGroup(group);
        if (group.id) dispatch({ type: 'UPDATE_GROUP', payload: saved });
        else dispatch({ type: 'ADD_GROUP', payload: saved });
        return saved;
      } else {
        const saved = { ...group, id: group.id || crypto.randomUUID() };
        if (group.id) dispatch({ type: 'UPDATE_GROUP', payload: saved });
        else dispatch({ type: 'ADD_GROUP', payload: saved });
        return saved;
      }
    }, []),

    deleteGroup: useCallback(async (id) => {
      if (hasApi()) await api().store.deleteGroup(id);
      dispatch({ type: 'DELETE_GROUP', payload: id });
    }, []),

    /* Snippets */
    saveSnippet: useCallback(async (snippet) => {
      if (hasApi()) {
        const saved = await api().store.saveSnippet(snippet);
        if (snippet.id) dispatch({ type: 'UPDATE_SNIPPET', payload: saved });
        else dispatch({ type: 'ADD_SNIPPET', payload: saved });
        return saved;
      } else {
        const saved = { ...snippet, id: snippet.id || crypto.randomUUID() };
        if (snippet.id) dispatch({ type: 'UPDATE_SNIPPET', payload: saved });
        else dispatch({ type: 'ADD_SNIPPET', payload: saved });
        return saved;
      }
    }, []),

    deleteSnippet: useCallback(async (id) => {
      if (hasApi()) await api().store.deleteSnippet(id);
      dispatch({ type: 'DELETE_SNIPPET', payload: id });
    }, []),

    /* Keys */
    importKey: useCallback(async () => {
      if (hasApi()) {
        const result = await api().store.importKey();
        if (result?.key) dispatch({ type: 'ADD_KEY', payload: result.key });
        return result?.key;
      }
    }, []),

    generateKey: useCallback(async (options) => {
      if (hasApi()) {
        const result = await api().store.generateKey(options);
        dispatch({ type: 'ADD_KEY', payload: result.key });
        return result.key;
      } else {
        const key = { id: crypto.randomUUID(), label: options.label || 'New Key', type: options.type || 'ED25519', fingerprint: 'SHA256:mock...', publicKey: 'ssh-ed25519 AAAA...mock', createdAt: new Date().toISOString().slice(0, 10) };
        dispatch({ type: 'ADD_KEY', payload: key });
        return key;
      }
    }, []),

    pasteKey: useCallback(async ({ name, privateKeyContent }) => {
      if (hasApi()) {
        const result = await api().store.pasteKey({ name, privateKeyContent });
        if (result?.key) dispatch({ type: 'ADD_KEY', payload: result.key });
        return result?.key;
      }
    }, []),

    deleteKey: useCallback(async (id) => {
      if (hasApi()) await api().store.deleteKey(id);
      dispatch({ type: 'DELETE_KEY', payload: id });
    }, []),

    /* Port Forwards. Rules carry no running flag: that is state.portForwardStatus. */
    savePortForward: useCallback(async (forward) => {
      // eslint-disable-next-line no-unused-vars
      const { active, ...rule } = forward;
      if (hasApi()) {
        const saved = await api().store.savePortForward(rule);
        if (rule.id) dispatch({ type: 'UPDATE_PORT_FORWARD', payload: saved });
        else dispatch({ type: 'ADD_PORT_FORWARD', payload: saved });
        return saved;
      } else {
        const saved = { ...rule, id: rule.id || crypto.randomUUID(), createdAt: rule.createdAt || new Date().toISOString() };
        if (rule.id) dispatch({ type: 'UPDATE_PORT_FORWARD', payload: saved });
        else dispatch({ type: 'ADD_PORT_FORWARD', payload: saved });
        return saved;
      }
    }, []),

    /* Main stops a running rule before deleting it */
    deletePortForward: useCallback(async (id) => {
      if (hasApi()) await api().store.deletePortForward(id);
      dispatch({ type: 'DELETE_PORT_FORWARD', payload: id });
      dispatch({ type: 'SET_PORT_FORWARD_STATUS', payload: { ruleId: id, state: 'stopped' } });
    }, []),

    /* Only the rule id goes to main, which resolves host and credentials.
       Never throws: a failure becomes state 'error' with main's message. */
    startPortForward: useCallback(async (ruleId) => {
      dispatch({ type: 'SET_PORT_FORWARD_STATUS', payload: { ruleId, state: 'starting' } });
      if (!hasApi()) {
        /* Browser dev mode: pretend, and fail the way main would without a host */
        const rule = stateRef.current.portForwards.find(p => p.id === ruleId);
        setTimeout(() => dispatch({
          type: 'SET_PORT_FORWARD_STATUS',
          payload: rule?.hostId
            ? { ruleId, state: 'running' }
            : { ruleId, state: 'error', error: 'Choose a host for this rule before starting it.' },
        }), 700);
        return;
      }
      try {
        const result = await api().portForward.start(ruleId);
        if (result?.state) dispatch({ type: 'SET_PORT_FORWARD_STATUS', payload: { ruleId, state: result.state } });
      } catch (err) {
        dispatch({ type: 'SET_PORT_FORWARD_STATUS', payload: { ruleId, state: 'error', error: err?.message || 'Could not start it' } });
      }
    }, []),

    stopPortForward: useCallback(async (ruleId) => {
      if (hasApi()) {
        try { await api().portForward.stop(ruleId); } catch (_) { /* nothing left to stop */ }
      }
      dispatch({ type: 'SET_PORT_FORWARD_STATUS', payload: { ruleId, state: 'stopped' } });
    }, []),

    /* Settings */
    saveSettings: useCallback(async (settings) => {
      if (hasApi()) await api().store.saveSettings(settings);
      dispatch({ type: 'SET_SETTINGS', payload: settings });
    }, []),

    /* SSH Connection */
    connectToHost: useCallback(async (host) => {
      const tabId = crypto.randomUUID();

      /* Create tab immediately with "connecting" status for visual feedback */
      dispatch({ type: 'ADD_TAB', payload: {
        id: tabId,
        type: 'terminal',
        label: host.label || host.hostname,
        sessionId: null,
        hostId: host.id,
        connecting: true,
        hostConfig: host,
      }});

      if (hasApi()) {
        /* A tab closed before this resolves gets its session disconnected, not added */
        return connectTab({ tabId, host, config: buildConnectConfig(host), ssh: api().ssh, dispatch });
      } else {
        /* Mock – open a demo terminal tab */
        const sessionId = `mock-${tabId}`;
        dispatch({ type: 'ADD_SESSION', payload: { sessionId, hostId: host.id, host, status: 'connected' } });
        dispatch({ type: 'UPDATE_TAB', payload: { id: tabId, sessionId, connecting: false } });
        return { tabId, sessionId };
      }
    }, []),

    disconnectSession: useCallback(async (sessionId) => {
      if (hasApi()) {
        try { await api().ssh.disconnect(sessionId); } catch (e) { /* ignore */ }
      }
      dispatch({ type: 'REMOVE_SESSION', payload: sessionId });
    }, []),

    /* Tabs */
    addTab: useCallback((tab) => dispatch({ type: 'ADD_TAB', payload: tab }), []),
    /* The home tab is not in `tabs`: it is what shows when activeTabId is null. */
    goHome: useCallback(() => dispatch({ type: 'SET_ACTIVE_TAB', payload: null }), []),
    openLocalTerminal: useCallback(() => {
      const tabId = crypto.randomUUID();
      dispatch({ type: 'ADD_TAB', payload: {
        id: tabId,
        type: 'local-terminal',
        label: 'Local Terminal',
        sessionId: `local-${tabId}`,
      }});
    }, []),
    removeTab: useCallback((tabId) => {
      /* Still connecting (or on the host-key prompt): connectToHost drops what it gets */
      markAbandoned(stateRef.current.tabs, tabId);
      dispatch({ type: 'REMOVE_TAB', payload: tabId });
    }, []),

    /* Split panes (desktop). groupId = the tab in the bar, paneId = one of its panes. */
    splitPane: useCallback((groupId, paneId, direction) => {
      const id = crypto.randomUUID();
      dispatch({ type: 'PANE_SPLIT', payload: {
        groupId, paneId, direction,
        newTab: { id, type: 'local-terminal', label: 'Terminal', sessionId: `local-${id}` },
      }});
    }, []),
    dropOnPane: useCallback((drag, groupId, paneId, zone) => dispatch({ type: 'PANE_DROP', payload: { drag, groupId, paneId, zone } }), []),
    detachPane: useCallback((paneId) => dispatch({ type: 'PANE_DETACH', payload: paneId }), []),
    ungroupTab: useCallback((groupId) => dispatch({ type: 'PANE_UNGROUP', payload: groupId }), []),
    focusPane: useCallback((groupId, paneId) => dispatch({ type: 'PANE_FOCUS', payload: { groupId, paneId } }), []),
    setPaneRatio: useCallback((groupId, path, ratio) => dispatch({ type: 'PANE_RATIO', payload: { groupId, path, ratio } }), []),
    setActiveTab: useCallback((tabId) => dispatch({ type: 'SET_ACTIVE_TAB', payload: tabId }), []),
    updateTab: useCallback((tab) => dispatch({ type: 'UPDATE_TAB', payload: tab }), []),

    /* Navigation */
    setActiveSection: useCallback((section) => dispatch({ type: 'SET_ACTIVE_SECTION', payload: section }), []),

    /* Host form */
    /* `defaults` only applies to a new host, e.g. the group being browsed. */
    openHostForm: useCallback((host, defaults) => dispatch({ type: 'OPEN_HOST_FORM', payload: host, defaults }), []),
    closeHostForm: useCallback(() => dispatch({ type: 'CLOSE_HOST_FORM' }), []),

    /* Broadcast */
    toggleBroadcast: useCallback(() => dispatch({ type: 'TOGGLE_BROADCAST' }), []),

    /* ── Sync ──
       Every call funnels through here so the "is the bridge there?" guard
       lives in one place. Shapes are normalized in components/Sync/helpers. */
    refreshSyncStatus: useCallback(async () => {
      const sync = syncApi();
      if (!sync?.status) return null;
      try {
        const status = await sync.status();
        dispatch({ type: 'SET_SYNC_STATUS', payload: status, replace: true });
        return status;
      } catch (err) {
        dispatch({
          type: 'SET_SYNC_STATUS',
          payload: { error: err?.message || 'Could not read sync status' },
          replace: true,
        });
        return null;
      }
    }, []),

    /* Opens the system browser and resolves only when the user finishes there,
       which can take minutes and expires after ten. Callers must keep their own
       waiting state; this one never rejects on its own timer. */
    syncLogin: useCallback(async () => {
      const sync = syncApi();
      if (!sync?.login) return noSync();
      return sync.login();
    }, []),

    syncLogout: useCallback(async () => {
      const sync = syncApi();
      if (!sync?.logout) return noSync();
      await sync.logout();
      dispatch({ type: 'SET_SYNC_STATUS', payload: { signedIn: false }, replace: true });
    }, []),

    syncNow: useCallback(async () => {
      const sync = syncApi();
      if (!sync?.syncNow) return noSync();
      return sync.syncNow();
    }, []),

    /* Account passphrase. Both resolve { unlocked, synced } and reject with the
       main process's message (wrong passphrase, too short, vault already
       exists…). The passphrase goes straight through: nothing here keeps it. */
    syncSetupPassphrase: useCallback(async (passphrase) => {
      const sync = syncApi();
      if (!sync?.setupPassphrase) return noSync();
      return sync.setupPassphrase(passphrase);
    }, []),

    syncUnlock: useCallback(async (passphrase) => {
      const sync = syncApi();
      if (!sync?.unlock) return noSync();
      return sync.unlock(passphrase);
    }, []),

    syncDevices: useCallback(async () => {
      const sync = syncApi();
      if (!sync?.devices) return noSync();
      return sync.devices();
    }, []),

    syncRevokeDevice: useCallback(async (id) => {
      const sync = syncApi();
      if (!sync?.revokeDevice) return noSync();
      return sync.revokeDevice(id);
    }, []),

    syncPairingRequest: useCallback(async () => {
      const sync = syncApi();
      if (!sync?.pairing?.request) return noSync();
      return sync.pairing.request();
    }, []),

    syncPairingPending: useCallback(async () => {
      const sync = syncApi();
      if (!sync?.pairing?.pending) return noSync();
      return sync.pairing.pending();
    }, []),

    /* Step 1 of two. Publishes this device's public key and nothing else, so
       both screens can show the same six digits. Resolves {state, digits}. */
    syncPairingApprove: useCallback(async (id) => {
      const sync = syncApi();
      if (!sync?.pairing?.approve) return noSync();
      return sync.pairing.approve(id);
    }, []),

    /* Step 2. The only call that lets the master key leave this device: it
       runs after the user says the six digits match on both screens. */
    syncPairingConfirm: useCallback(async (id) => {
      const sync = syncApi();
      if (!sync?.pairing?.confirm) return noSync();
      return sync.pairing.confirm(id);
    }, []),

    syncPairingReject: useCallback(async (id) => {
      const sync = syncApi();
      if (!sync?.pairing?.reject) return noSync();
      return sync.pairing.reject(id);
    }, []),

    syncPairingClaim: useCallback(async (id) => {
      const sync = syncApi();
      if (!sync?.pairing?.claim) return noSync();
      return sync.pairing.claim(id);
    }, []),

    /* Re-read every collection from the store. Used after a sync pull, which
       rewrites the JSON files under the renderer's feet (tombstones included). */
    reloadStore: useCallback(async () => {
      if (!hasApi()) return;
      const [hosts, groups, snippets, keys, portForwards, settings] = await Promise.all([
        api().store.getHosts(),
        api().store.getGroups(),
        api().store.getSnippets(),
        api().store.getKeys(),
        api().store.getPortForwards(),
        api().store.getSettings(),
      ]);
      dispatch({
        type: 'INIT_DATA',
        payload: {
          hosts: hosts || [],
          groups: groups || [],
          snippets: snippets || [],
          keys: keys || [],
          portForwards: portForwards || [],
          settings: settings || MOCK_SETTINGS,
        },
      });
    }, []),

    /* ── Known hosts (local only; the section keeps the list in its own state) ── */
    listKnownHosts: useCallback(async () => {
      if (!hasApi()) return MOCK_KNOWN_HOSTS;
      const kh = api().knownHosts;
      if (!kh?.list) return [];
      return (await kh.list()) || [];
    }, []),
    deleteKnownHost: useCallback(async (id) => {
      if (!hasApi()) return true;
      return api().knownHosts.delete(id);
    }, []),
    /* {imported, duplicates, skipped, reasons} — main reads ~/.ssh/known_hosts */
    importKnownHosts: useCallback(async () => {
      if (!hasApi()) return { imported: 0, duplicates: 0, skipped: 0, reasons: {} };
      return api().knownHosts.importFromSsh();
    }, []),

    /* ── Connection logs (recorded in main; local only) ── */
    listConnectionLogs: useCallback(async () => {
      if (!hasApi()) return MOCK_CONNECTION_LOGS;
      const logs = api().logs;
      if (!logs?.list) return [];
      return (await logs.list()) || [];
    }, []),
    clearConnectionLogs: useCallback(async () => {
      if (!hasApi()) return true;
      return api().logs.clear();
    }, []),

    /* ── SFTP ──
       An SFTP tab is only a layout: {left, right} pane sources, each
       {kind:'local'} | {kind:'host', hostId} | null (pick one). Panes connect
       themselves (connectSftp) and close what they opened when they unmount,
       so closing the tab is just removing it. */
    openSFTPTab: useCallback((host) => {
      const tabId = crypto.randomUUID();
      dispatch({ type: 'ADD_TAB', payload: {
        id: tabId,
        type: 'sftp',
        label: host ? `SFTP · ${host.label || host.hostname}` : 'SFTP',
        hostId: host?.id,
        panes: { left: { kind: 'local' }, right: host ? { kind: 'host', hostId: host.id } : null },
      } });
      return { tabId };
    }, []),

    /* Sidebar "SFTP": back to the last SFTP tab, or a new one. */
    openSFTP: useCallback(() => {
      const existing = stateRef.current.tabs.filter(t => t.type === 'sftp');
      if (existing.length) {
        dispatch({ type: 'SET_ACTIVE_TAB', payload: existing[existing.length - 1].id });
        return { tabId: existing[existing.length - 1].id };
      }
      const tabId = crypto.randomUUID();
      dispatch({ type: 'ADD_TAB', payload: { id: tabId, type: 'sftp', label: 'SFTP', panes: { left: { kind: 'local' }, right: null } } });
      return { tabId };
    }, []),

    /* A pane's connection to `host`: the session of an open terminal to that
       host when there is one (owned: false — the terminal keeps it), else a
       connection of its own (ssh:connect purpose:'sftp', no shell; host key
       verified like any other; logged as sftp). The caller disconnects only
       what it owns. */
    connectSftp: useCallback(async (host) => {
      const st = stateRef.current;
      const reusable = st.tabs.find(t => t.type === 'terminal' && t.hostId === host.id && t.sessionId
        && !t.connecting && !t.error && st.activeSessions[t.sessionId]);
      if (reusable) return { sessionId: reusable.sessionId, owned: false };
      if (!hasApi()) {
        await new Promise(r => setTimeout(r, 250));
        const sessionId = mockConnect(host);
        dispatch({ type: 'ADD_SESSION', payload: { sessionId, hostId: host.id, host, status: 'connected', sftp: true } });
        return { sessionId, owned: true };
      }
      const { sessionId } = await api().ssh.connect({ ...buildConnectConfig(host), purpose: 'sftp' });
      dispatch({ type: 'ADD_SESSION', payload: { sessionId, hostId: host.id, host, status: 'connected', sftp: true } });
      return { sessionId, owned: true };
    }, []),
  };

  /**
   * Remote OS detection (`ssh:os-detected`) -> `host.os`, for the distro logo
   * on the host cards. Saved only when the value changed, and never for:
   * - hosts that are not in the store (quick connect makes a throwaway id);
   * - hosts sync could not open here (`undecryptableIds` has `hosts/<id>`).
   *   Their password is sealed with another computer's key, and a local save
   *   is a real edit that REPLACES that sealed remote copy, destroying the
   *   only readable password. If we cannot tell, we do not save.
   * The write is `store.setHostOs(hostId, os)`: main sets ONLY `os` on the
   * host as it is on disk, under the store lock, and repeats the sealed check
   * there. Never a full-object saveHost from here: a sync pull may have just
   * rewritten hosts.json, and this renderer copy would overwrite it (password
   * included) and push the stale version.
   */
  useEffect(() => {
    const ssh = window.electronAPI?.ssh;
    if (!ssh || typeof ssh.onOsDetected !== 'function') return undefined;
    let alive = true;
    const inFlight = new Set();

    const isSealed = async (hostId) => {
      const tag = `hosts/${hostId}`;
      if ((stateRef.current.sync?.status?.undecryptableIds || []).includes(tag)) return true;
      const sync = window.electronAPI?.sync;
      /* No sync bridge: there is no remote copy to overwrite. */
      if (!sync || typeof sync.status !== 'function') return false;
      /* Ask main now rather than trust a status that may not have loaded yet.
         A throw propagates and the caller skips the save. */
      const s = await sync.status();
      if (!s || !Array.isArray(s.undecryptableIds)) return true;
      return s.undecryptableIds.includes(tag);
    };

    const handle = async (sessionId, os, attempt = 0) => {
      if (!alive) return;
      const session = stateRef.current.activeSessions[sessionId];
      if (!session) {
        /* The event can in theory beat ADD_SESSION; give it a moment. */
        if (attempt < 10) setTimeout(() => handle(sessionId, os, attempt + 1), 300);
        return;
      }
      const hostId = session.hostId;
      if (!hostId || inFlight.has(hostId)) return;
      const current = stateRef.current.hosts.find(h => h.id === hostId);
      if (!current || current.os === os) return;
      inFlight.add(hostId);
      try {
        if (await isSealed(hostId)) return;
        if (!alive || typeof window.electronAPI?.store?.setHostOs !== 'function') return;
        const saved = await window.electronAPI.store.setHostOs(hostId, os);
        if (alive && saved && saved.id === hostId) dispatch({ type: 'UPDATE_HOST', payload: saved });
      } catch (_) {
        /* Cosmetic: a failed save just means no logo this time. */
      } finally {
        inFlight.delete(hostId);
      }
    };

    const listener = ssh.onOsDetected((payload) => {
      const sessionId = payload?.sessionId;
      const os = payload?.os;
      if (typeof sessionId !== 'string' || typeof os !== 'string' || !os) return;
      handle(sessionId, os);
    });

    return () => {
      alive = false;
      ssh.removeOsDetectedListener?.(listener);
    };
  }, []);

  /* A rule deleted elsewhere (a sync pull rewrites the collection) while it
     runs here would keep its tunnel open with no card left to stop it. */
  const { stopPortForward } = actions;
  useEffect(() => {
    if (state.loading) return;
    const ids = new Set(state.portForwards.map(p => p.id));
    for (const ruleId of Object.keys(state.portForwardStatus)) {
      if (!ids.has(ruleId)) stopPortForward(ruleId);
    }
  }, [state.loading, state.portForwards, state.portForwardStatus, stopPortForward]);

  return (
    <AppContext.Provider value={{ state, dispatch, actions }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}

export default AppContext;
