import React, { createContext, useContext, useReducer, useEffect, useCallback } from 'react';
import { normalizeSyncStatus } from '../components/Sync/helpers';

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
  settings: MOCK_SETTINGS,
  activeSessions: {},     // sessionId -> { hostId, host, status }
  tabs: [],               // { id, type:'terminal'|'sftp', label, sessionId?, hostId? }
  activeTabId: null,
  activeSection: 'hosts', // hosts | sftp | snippets | port-forwarding | keychain | settings
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
function appReducer(state, action) {
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
      return {
        ...state,
        activeTabId: action.payload,
        tabs: state.tabs.map(t => t.id === action.payload ? { ...t, notify: false } : t),
      };
    case 'TAB_NOTIFY':
      return {
        ...state,
        tabs: state.tabs.map(t => t.id === action.payload ? { ...t, notify: true } : t),
      };
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

    syncPairingApprove: useCallback(async (id) => {
      const sync = syncApi();
      if (!sync?.pairing?.approve) return noSync();
      return sync.pairing.approve(id);
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
