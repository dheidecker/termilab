import React, { createContext, useContext, useReducer, useEffect, useCallback } from 'react';

const AppContext = createContext(null);

/* ── Mock data for browser dev without Electron ── */
const MOCK_HOSTS = [
  { id: '1', label: 'Production Server', hostname: '192.168.1.100', port: 22, username: 'root', authType: 'password', groupId: 'g1', tags: ['prod'] },
  { id: '2', label: 'Staging Server', hostname: '192.168.1.101', port: 22, username: 'deploy', authType: 'key', keyId: 'k1', groupId: 'g1', tags: ['staging'] },
  { id: '3', label: 'Database Server', hostname: '10.0.0.50', port: 2222, username: 'admin', authType: 'password', groupId: 'g2', tags: ['db'] },
  { id: '4', label: 'Dev Machine', hostname: 'dev.local', port: 22, username: 'derek', authType: 'key', keyId: 'k1', groupId: null, tags: [] },
];

const MOCK_GROUPS = [
  { id: 'g1', label: 'Web Servers', color: '#58a6ff' },
  { id: 'g2', label: 'Databases', color: '#3fb950' },
];

const MOCK_SNIPPETS = [
  { id: 's1', name: 'System Update', command: 'sudo apt update && sudo apt upgrade -y', description: 'Update system packages' },
  { id: 's2', name: 'Disk Usage', command: 'df -h', description: 'Check disk space' },
  { id: 's3', name: 'Docker Status', command: 'docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"', description: 'List running containers' },
];

const MOCK_KEYS = [
  { id: 'k1', label: 'Personal Key', type: 'ED25519', fingerprint: 'SHA256:xXxXxXxXxXxXxXxXxXxXxXxXx', publicKey: 'ssh-ed25519 AAAA...', createdAt: '2024-01-15' },
];

const MOCK_PORT_FORWARDS = [];

const MOCK_SETTINGS = {
  terminal: { fontSize: 14, fontFamily: 'JetBrains Mono', cursorStyle: 'block', scrollback: 5000 },
  appearance: { theme: 'dark', accentColor: '#58a6ff' },
  ssh: { defaultPort: 22, keepAliveInterval: 30 },
  general: { autoConnect: false, restoreTabs: false },
};

/* ── Helper to check Electron API ── */
const api = () => window.electronAPI;
const hasApi = () => typeof window !== 'undefined' && !!window.electronAPI;

/* ── Initial State ── */
const initialState = {
  hosts: [],
  groups: [],
  snippets: [],
  keys: [],
  portForwards: [],
  settings: MOCK_SETTINGS,
  activeSessions: {},     // sessionId -> { hostId, host, status }
  tabs: [],               // { id, type:'terminal'|'sftp', label, sessionId?, hostId? }
  activeTabId: null,
  activeSection: 'hosts', // hosts | sftp | snippets | port-forwarding | keychain | settings
  loading: true,
  hostFormOpen: false,
  editingHost: null,
};

/* ── Reducer ── */
function appReducer(state, action) {
  switch (action.type) {
    /* ── Data loading ── */
    case 'SET_LOADING':
      return { ...state, loading: action.payload };
    case 'INIT_DATA':
      return { ...state, ...action.payload, loading: false };

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
    case 'REMOVE_TAB': {
      const remaining = state.tabs.filter(t => t.id !== action.payload);
      let newActiveTabId = state.activeTabId;
      if (state.activeTabId === action.payload) {
        const idx = state.tabs.findIndex(t => t.id === action.payload);
        newActiveTabId = remaining.length > 0
          ? (remaining[Math.min(idx, remaining.length - 1)]?.id ?? null)
          : null;
      }
      return { ...state, tabs: remaining, activeTabId: newActiveTabId };
    }
    case 'SET_ACTIVE_TAB':
      return { ...state, activeTabId: action.payload };
    case 'UPDATE_TAB':
      return { ...state, tabs: state.tabs.map(t => t.id === action.payload.id ? { ...t, ...action.payload } : t) };

    /* ── Navigation ── */
    case 'SET_ACTIVE_SECTION':
      return { ...state, activeSection: action.payload };

    /* ── Host form ── */
    case 'OPEN_HOST_FORM':
      return { ...state, hostFormOpen: true, editingHost: action.payload || null };
    case 'CLOSE_HOST_FORM':
      return { ...state, hostFormOpen: false, editingHost: null };

    default:
      return state;
  }
}

/* ── Provider ── */
export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(appReducer, initialState);

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
      }
    }
    loadData();
  }, []);

  /* Apply accent color to CSS variables when settings change */
  useEffect(() => {
    const accent = state.settings?.appearance?.accentColor;
    if (accent) {
      const root = document.documentElement;
      root.style.setProperty('--accent', accent);
      /* Generate lighter variant for hover */
      const r = parseInt(accent.slice(1, 3), 16);
      const g = parseInt(accent.slice(3, 5), 16);
      const b = parseInt(accent.slice(5, 7), 16);
      const lighter = `rgb(${Math.min(r + 30, 255)}, ${Math.min(g + 30, 255)}, ${Math.min(b + 30, 255)})`;
      root.style.setProperty('--accent-hover', lighter);
      root.style.setProperty('--accent-muted', `rgba(${r}, ${g}, ${b}, 0.15)`);
      root.style.setProperty('--accent-subtle', `rgba(${r}, ${g}, ${b}, 0.08)`);
    }
  }, [state.settings?.appearance?.accentColor]);

  /* ── Action creators ── */
  const actions = {
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

    deleteKey: useCallback(async (id) => {
      if (hasApi()) await api().store.deleteKey(id);
      dispatch({ type: 'DELETE_KEY', payload: id });
    }, []),

    /* Port Forwards */
    savePortForward: useCallback(async (forward) => {
      if (hasApi()) {
        const saved = await api().store.savePortForward(forward);
        if (forward.id) dispatch({ type: 'UPDATE_PORT_FORWARD', payload: saved });
        else dispatch({ type: 'ADD_PORT_FORWARD', payload: saved });
        return saved;
      } else {
        const saved = { ...forward, id: forward.id || crypto.randomUUID(), active: false };
        if (forward.id) dispatch({ type: 'UPDATE_PORT_FORWARD', payload: saved });
        else dispatch({ type: 'ADD_PORT_FORWARD', payload: saved });
        return saved;
      }
    }, []),

    deletePortForward: useCallback(async (id) => {
      if (hasApi()) await api().store.deletePortForward(id);
      dispatch({ type: 'DELETE_PORT_FORWARD', payload: id });
    }, []),

    startPortForward: useCallback(async (forwardConfig) => {
      if (hasApi()) {
        await api().portForward.start(forwardConfig);
      }
    }, []),

    stopPortForward: useCallback(async (forwardId) => {
      if (hasApi()) {
        await api().portForward.stop(forwardId);
      }
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
        try {
          const config = {
            host: host.hostname,
            port: host.port || 22,
            username: host.username,
          };
          if (host.authType === 'password') config.password = host.password || '';
          if (host.authType === 'key' && host.keyId) config.keyId = host.keyId;
          if (host.authType === 'key' && host.privateKey) config.privateKey = host.privateKey;

          const result = await api().ssh.connect(config);
          const sessionId = result.sessionId;
          dispatch({ type: 'ADD_SESSION', payload: { sessionId, hostId: host.id, host, status: 'connected' } });
          /* Update the tab with the sessionId and mark as connected */
          dispatch({ type: 'UPDATE_TAB', payload: { id: tabId, sessionId, connecting: false } });
          return { tabId, sessionId };
        } catch (err) {
          console.error('SSH connection failed:', err);
          dispatch({ type: 'UPDATE_TAB', payload: { id: tabId, connecting: false, error: err.message } });
          throw err;
        }
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
    removeTab: useCallback((tabId) => dispatch({ type: 'REMOVE_TAB', payload: tabId }), []),
    setActiveTab: useCallback((tabId) => dispatch({ type: 'SET_ACTIVE_TAB', payload: tabId }), []),
    updateTab: useCallback((tab) => dispatch({ type: 'UPDATE_TAB', payload: tab }), []),

    /* Navigation */
    setActiveSection: useCallback((section) => dispatch({ type: 'SET_ACTIVE_SECTION', payload: section }), []),

    /* Host form */
    openHostForm: useCallback((host) => dispatch({ type: 'OPEN_HOST_FORM', payload: host }), []),
    closeHostForm: useCallback(() => dispatch({ type: 'CLOSE_HOST_FORM' }), []),

    /* Open SFTP tab */
    openSFTPTab: useCallback(async (host) => {
      const tabId = crypto.randomUUID();
      let sessionId;
      if (hasApi()) {
        try {
          const config = {
            host: host.hostname,
            port: host.port || 22,
            username: host.username,
          };
          if (host.authType === 'password') config.password = host.password || '';
          if (host.authType === 'key' && host.keyId) config.keyId = host.keyId;
          if (host.authType === 'key' && host.privateKey) config.privateKey = host.privateKey;
          const result = await api().ssh.connect(config);
          sessionId = result.sessionId;
        } catch (err) {
          console.error('SFTP connection failed:', err);
          throw err;
        }
      } else {
        sessionId = `mock-sftp-${tabId}`;
      }
      dispatch({ type: 'ADD_SESSION', payload: { sessionId, hostId: host.id, host, status: 'connected' } });
      dispatch({ type: 'ADD_TAB', payload: { id: tabId, type: 'sftp', label: `SFTP: ${host.label || host.hostname}`, sessionId, hostId: host.id } });
      return { tabId, sessionId };
    }, []),
  };

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
